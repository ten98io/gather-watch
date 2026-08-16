/**
 * Minimal S3-compatible client: raw SigV4 over global fetch, node:crypto only.
 * Implements the ObjectStorage port. Extends the approach services/api's chat
 * attachments proved against MinIO (query-presigned PUT) with header-signed
 * control calls (initiate/complete/abort multipart, list, get, put, delete).
 *
 * Addressing (path-style vs virtual-hosted) and region come from config — see
 * storage/url.ts; nothing here may assume either.
 *
 * Scope note: keys are service-generated ([A-Za-z0-9._/-]), so XML parsing is
 * regex-level and XML escaping is defensive only.
 */
import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { AppConfig } from '../config';
import { AppError } from '../lib/errors';
import type { CompletedPart, ObjectStorage } from './ports';
import { bucketPath, encodeKey, objectPath, requestHost, requestOrigin, uriEncode } from './url';

type S3Config = AppConfig['s3'];

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Minimal XML unescape for values we read back (defensive; keys are safe). */
function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const REQUEST_TIMEOUT_MS = 60_000;

export class S3Storage implements ObjectStorage {
  private readonly s3: S3Config;
  /** Signed `host` header — carries the bucket subdomain when virtual-hosted. */
  private readonly host: string;
  /** Scheme + authority every request URL is built on. */
  private readonly origin: string;
  private readonly ttlSec: number;

  constructor(s3: S3Config, presignTtlSec = 900) {
    this.s3 = s3;
    this.host = requestHost(s3.endpoint, s3.bucket, s3.pathStyle);
    this.origin = requestOrigin(s3.endpoint, s3.bucket, s3.pathStyle);
    this.ttlSec = presignTtlSec;
  }

  publicUrl(key: string): string {
    return `${this.s3.publicBaseUrl}/${encodeKey(key)}`;
  }

  // ── SigV4 primitives ───────────────────────────────────────────────────────

  private signingKey(dateStamp: string): Buffer {
    return hmac(
      hmac(hmac(hmac(`AWS4${this.s3.secretKey}`, dateStamp), this.s3.region), 's3'),
      'aws4_request',
    );
  }

  private credentialScope(dateStamp: string): string {
    return `${dateStamp}/${this.s3.region}/s3/aws4_request`;
  }

  /** 2026-08-15T00:00:00.000Z → [amzDate 20260815T000000Z, dateStamp 20260815] */
  private static dates(now: Date): [string, string] {
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return [amzDate, amzDate.slice(0, 8)];
  }

  private canonicalUri(key: string): string {
    return objectPath(this.s3.endpoint, this.s3.bucket, key, this.s3.pathStyle);
  }

  /** Canonical URI of a bucket-level call ('/' when virtual-hosted). */
  private bucketUri(): string {
    return bucketPath(this.s3.endpoint, this.s3.bucket, this.s3.pathStyle);
  }

  private static canonicalQuery(params: Record<string, string>): string {
    return Object.keys(params)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(params[k] ?? '')}`)
      .join('&');
  }

  /**
   * Header-signed request. Returns the fetch Response (caller checks status /
   * consumes the body). `extraHeaders` are folded into the signature.
   */
  private async signedRequest(
    method: string,
    key: string | null,
    query: Record<string, string>,
    body: string | Buffer,
    extraHeaders: Record<string, string> = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const [amzDate, dateStamp] = S3Storage.dates(new Date());
    const payloadHash = sha256Hex(body);

    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name] ?? ''}\n`).join('');
    const signedHeaders = signedNames.join(';');

    const canonicalQuery = S3Storage.canonicalQuery(query);
    const path = key === null ? this.bucketUri() : this.canonicalUri(key);
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      this.credentialScope(dateStamp),
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signature = createHmac('sha256', this.signingKey(dateStamp))
      .update(stringToSign)
      .digest('hex');

    const queryString = canonicalQuery === '' ? '' : `?${canonicalQuery}`;

    return fetch(`${this.origin}${path}${queryString}`, {
      method,
      headers: {
        ...extraHeaders,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.s3.accessKey}/${this.credentialScope(
          dateStamp,
        )}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: body === '' ? null : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** Throws AppError('INTERNAL') with a trimmed response body on non-2xx. */
  private static async expectOk(res: Response, op: string): Promise<Response> {
    if (res.status >= 200 && res.status < 300) {
      // S3 can embed <Error> in a 200 complete-multipart response. Only peek
      // at XML bodies — getObject streams must not be buffered twice.
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('xml')) {
        const peek = await res.clone().text();
        if (peek.includes('<Error>')) {
          throw new AppError('INTERNAL', `s3 ${op} failed: ${peek.slice(0, 300)}`);
        }
      }
      return res;
    }
    const text = await res.text().catch(() => '');
    throw new AppError('INTERNAL', `s3 ${op} failed with ${res.status}: ${text.slice(0, 300)}`);
  }

  // ── ObjectStorage ──────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      const res = await this.signedRequest('HEAD', null, {}, '');
      await res.arrayBuffer().catch(() => undefined);
      // Any non-5xx HTTP answer means the endpoint is reachable (403/404 still
      // prove S3 is alive; bucket existence is a deploy concern).
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async createMultipartUpload(key: string, mime: string): Promise<string> {
    const res = await S3Storage.expectOk(
      await this.signedRequest('POST', key, { uploads: '' }, '', { 'content-type': mime }),
      'createMultipartUpload',
    );
    const text = await res.text();
    const match = /<UploadId>([^<]+)<\/UploadId>/.exec(text);
    if (match === null) {
      throw new AppError('INTERNAL', `s3 createMultipartUpload: no UploadId in response`);
    }
    return xmlUnescape(match[1] ?? '');
  }

  presignUploadPart(key: string, uploadId: string, partNumber: number): string {
    const [amzDate, dateStamp] = S3Storage.dates(new Date());
    const credential = `${this.s3.accessKey}/${this.credentialScope(dateStamp)}`;

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': credential,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(this.ttlSec),
      'X-Amz-SignedHeaders': 'host',
      partNumber: String(partNumber),
      uploadId,
    };
    const canonicalQuery = S3Storage.canonicalQuery(query);

    const canonicalRequest = [
      'PUT',
      this.canonicalUri(key),
      canonicalQuery,
      `host:${this.host}`,
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      this.credentialScope(dateStamp),
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signature = createHmac('sha256', this.signingKey(dateStamp))
      .update(stringToSign)
      .digest('hex');

    return `${this.origin}${this.canonicalUri(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<void> {
    const xml =
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>';
    await S3Storage.expectOk(
      await this.signedRequest('POST', key, { uploadId }, xml, {
        'content-type': 'application/xml',
      }),
      'completeMultipartUpload',
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await S3Storage.expectOk(
      await this.signedRequest('DELETE', key, { uploadId }, ''),
      'abortMultipartUpload',
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await S3Storage.expectOk(await this.signedRequest('GET', key, {}, ''), 'getObject');
    return Buffer.from(await res.arrayBuffer());
  }

  /** GB-scale sources stream straight to disk (an hour-long timeout instead
   *  of the 60 s control-call budget; never buffered). */
  async getObjectToFile(key: string, destPath: string): Promise<void> {
    const res = await S3Storage.expectOk(
      await this.signedRequest('GET', key, {}, '', {}, 60 * 60 * 1000),
      'getObjectToFile',
    );
    if (res.body === null) {
      await writeFile(destPath, Buffer.alloc(0));
      return;
    }
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(destPath));
  }

  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    const res = await this.signedRequest('HEAD', key, {}, '');
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new AppError('INTERNAL', `s3 headObject failed with ${res.status}`);
    }
    const size = Number(res.headers.get('content-length'));
    if (!Number.isFinite(size) || size < 0) {
      throw new AppError('INTERNAL', 's3 headObject: missing content-length');
    }
    return { sizeBytes: size };
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await S3Storage.expectOk(
      await this.signedRequest('PUT', key, {}, body, { 'content-type': contentType }),
      'putObject',
    );
  }

  async deleteObject(key: string): Promise<void> {
    const res = await this.signedRequest('DELETE', key, {}, '');
    // 404 = already gone; delete stays idempotent.
    if (res.status !== 404) {
      await S3Storage.expectOk(res, 'deleteObject');
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    let continuationToken: string | null = null;
    do {
      const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000', prefix };
      if (continuationToken !== null) query['continuation-token'] = continuationToken;
      const res = await S3Storage.expectOk(
        await this.signedRequest('GET', null, query, ''),
        'deletePrefix:list',
      );
      const text = await res.text();
      const keys = [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => xmlUnescape(m[1] ?? ''));
      for (const key of keys) {
        await this.deleteObject(key);
      }
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(text);
      continuationToken = next === null ? null : xmlUnescape(next[1] ?? '');
    } while (continuationToken !== null);
  }
}
