import type { MediaAsset } from '@gather/contracts';
import type { RestClient } from './rest';
import { defaultFetch, defaultSetTimeout } from './types';
import type { FetchLike, SetTimeoutFn } from './types';

/** A readable byte source for a chunked upload. */
export interface UploadSource {
  filename: string;
  mime: string;
  sizeBytes: number;
  /** Reads bytes in [startByte, endByteExclusive). */
  readPart(startByte: number, endByteExclusive: number): Promise<Uint8Array>;
}

/** Progress snapshot emitted after each completed part. */
export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  partsCompleted: number;
  partsTotal: number;
  /** 0..1 */
  fraction: number;
}

/** Error thrown by {@link ChunkedUploader}. */
export class UploadError extends Error {
  /** 1-based part number, null when not part-specific (e.g. aborted). */
  readonly partNumber: number | null;

  constructor(message: string, partNumber?: number | null) {
    super(message);
    this.name = 'UploadError';
    this.partNumber = partNumber ?? null;
  }
}

/** Options for {@link ChunkedUploader}. */
export interface ChunkedUploaderOptions {
  /** Fetch used ONLY for the presigned part PUTs; defaults to platform fetch. */
  fetchImpl?: FetchLike;
  /** Maximum concurrent part PUTs. Defaults to 4. */
  concurrency?: number;
  /** Total attempts per part (1 try + retries). Defaults to 3. */
  maxAttemptsPerPart?: number;
  /** Base retry delay in ms; delay before retry k is retryDelayMs * k. Defaults to 250. */
  retryDelayMs?: number;
  /** Timer scheduler for retry delays. Defaults to a lazy globalThis setTimeout. */
  setTimeoutFn?: SetTimeoutFn;
  /** Progress callback invoked after each completed part. */
  onProgress?: (p: UploadProgress) => void;
}

interface ActiveUpload {
  aborted: boolean;
  waiters: Set<() => void>;
}

/**
 * Uploads a byte source through a presigned multipart upload session:
 * createUpload, parallel part PUTs with per-part retries, then
 * completeUpload. The instance is reusable once an upload settles.
 */
export class ChunkedUploader {
  private readonly rest: RestClient;
  private readonly fetchImplOpt: FetchLike | undefined;
  private readonly concurrency: number;
  private readonly maxAttemptsPerPart: number;
  private readonly retryDelayMs: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly onProgress: ((p: UploadProgress) => void) | undefined;
  private active: ActiveUpload | null = null;

  constructor(rest: RestClient, opts?: ChunkedUploaderOptions) {
    this.rest = rest;
    this.fetchImplOpt = opts?.fetchImpl;
    this.concurrency = opts?.concurrency ?? 4;
    this.maxAttemptsPerPart = opts?.maxAttemptsPerPart ?? 3;
    this.retryDelayMs = opts?.retryDelayMs ?? 250;
    this.setTimeoutFn = opts?.setTimeoutFn ?? defaultSetTimeout;
    this.onProgress = opts?.onProgress;
  }

  /**
   * Runs a full chunked upload and resolves with the completed media asset.
   * Rejects with {@link UploadError} on abort, exhausted part retries, or a
   * missing fetch implementation.
   */
  upload(source: UploadSource): Promise<MediaAsset> {
    if (this.active !== null) {
      return Promise.reject(new UploadError('upload already in progress', null));
    }
    const state: ActiveUpload = { aborted: false, waiters: new Set() };
    this.active = state;
    const abortSignal = new Promise<never>((_resolve, reject) => {
      state.waiters.add(() => {
        reject(new UploadError('aborted', null));
      });
    });
    const inner = this.run(source, state);
    // In-flight work settling after an abort must not surface as unhandled.
    inner.catch(() => {});
    return Promise.race([inner, abortSignal]).finally(() => {
      this.active = null;
    });
  }

  /** Aborts any in-progress upload; pending retry sleeps reject immediately. */
  abort(): void {
    const state = this.active;
    if (state === null) return;
    state.aborted = true;
    for (const wake of state.waiters) {
      wake();
    }
    state.waiters.clear();
  }

  private async run(source: UploadSource, state: ActiveUpload): Promise<MediaAsset> {
    const fetchImpl = this.fetchImplOpt ?? defaultFetch();
    if (fetchImpl === undefined) {
      throw new UploadError('no fetch implementation available', null);
    }

    const created = await this.rest.media.createUpload({
      filename: source.filename,
      mime: source.mime,
      sizeBytes: source.sizeBytes,
    });
    const { assetId, uploadId, parts } = created;
    const partSize = Math.ceil(source.sizeBytes / parts.length);
    const totalBytes = source.sizeBytes;
    const queue = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const completed: { partNumber: number; etag: string }[] = [];
    let uploadedBytes = 0;
    let partsCompleted = 0;
    let failure: UploadError | null = null;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (state.aborted) {
          if (failure === null) failure = new UploadError('aborted', null);
          return;
        }
        if (failure !== null) return;
        const part = queue.shift();
        if (part === undefined) return;
        // Prefer server-authoritative byte ranges; fall back to the documented
        // ceil-split convention (see CreateUploadResponse in contracts).
        const start = part.startByte ?? (part.partNumber - 1) * partSize;
        const end = part.endByte ?? Math.min(totalBytes, part.partNumber * partSize);
        try {
          const result = await this.uploadPart(fetchImpl, part.url, part.partNumber, source, start, end, state);
          if (failure !== null || state.aborted) return;
          uploadedBytes += result.byteLength;
          partsCompleted += 1;
          completed.push({ partNumber: part.partNumber, etag: result.etag });
          this.onProgress?.({
            uploadedBytes,
            totalBytes,
            partsCompleted,
            partsTotal: parts.length,
            fraction: totalBytes === 0 ? 1 : uploadedBytes / totalBytes,
          });
        } catch (err) {
          if (failure === null) {
            failure =
              err instanceof UploadError
                ? err
                : new UploadError(`part ${part.partNumber} failed`, part.partNumber);
          }
          return;
        }
      }
    };

    const workerCount = Math.max(1, Math.min(this.concurrency, parts.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (failure !== null) throw failure;
    if (state.aborted) throw new UploadError('aborted', null);

    completed.sort((a, b) => a.partNumber - b.partNumber);
    const done = await this.rest.media.completeUpload({ assetId, uploadId, parts: completed });
    return done.asset;
  }

  private async uploadPart(
    fetchImpl: FetchLike,
    url: string,
    partNumber: number,
    source: UploadSource,
    start: number,
    end: number,
    state: ActiveUpload,
  ): Promise<{ etag: string; byteLength: number }> {
    for (let attempt = 1; ; attempt += 1) {
      if (state.aborted) throw new UploadError('aborted', null);
      try {
        const bytes = await source.readPart(start, end);
        const res = await fetchImpl(url, { method: 'PUT', body: bytes });
        if (!res.ok) throw new Error(`part PUT responded with status ${res.status}`);
        const rawEtag = res.headers.get('etag');
        const etag = rawEtag === null ? '' : rawEtag.replace(/^"+|"+$/g, '');
        if (etag === '') {
          // completeUpload requires a non-empty ETag per part; retrying will
          // not help (the header is hidden by configuration, not by chance),
          // so fail fast with an actionable message. Browsers only expose the
          // ETag response header when the bucket CORS sets ExposeHeaders: ETag.
          throw new UploadError(
            `part ${partNumber}: upload succeeded but no ETag was exposed — ` +
              'check the S3/MinIO bucket CORS configuration (ExposeHeaders: ETag)',
            partNumber,
          );
        }
        return { etag, byteLength: bytes.length };
      } catch (err) {
        if (err instanceof UploadError) throw err;
        if (attempt >= this.maxAttemptsPerPart) {
          throw new UploadError(
            `part ${partNumber} failed after ${this.maxAttemptsPerPart} attempts`,
            partNumber,
          );
        }
        await this.sleep(this.retryDelayMs * attempt, state);
      }
    }
  }

  /** Abortable sleep: rejects immediately when the upload is aborted. */
  private sleep(ms: number, state: ActiveUpload): Promise<void> {
    return new Promise((resolve, reject) => {
      if (state.aborted) {
        reject(new UploadError('aborted', null));
        return;
      }
      const wake = () => {
        state.waiters.delete(wake);
        reject(new UploadError('aborted', null));
      };
      state.waiters.add(wake);
      this.setTimeoutFn(() => {
        state.waiters.delete(wake);
        resolve();
      }, ms);
    });
  }
}
