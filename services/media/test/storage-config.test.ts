/**
 * Storage configuration + S3 addressing. The trap these tests pin: a
 * Railway-linked bucket (Tigris) is VIRTUAL-HOSTED, and the path-style URLs
 * this client was written with against MinIO fail there as a 404 or a
 * signature mismatch — never as a config error. So the URL that is actually
 * built (and the host that is actually signed) is asserted, not just the flag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { S3Storage } from '../src/storage/s3';

/** A linked Railway Bucket injects exactly these five names. */
const RAILWAY_ENV = {
  BUCKET: 'gather-prod-bucket',
  ACCESS_KEY_ID: 'railway-key-id',
  SECRET_ACCESS_KEY: 'railway-secret-value',
  REGION: 'auto',
  ENDPOINT: 'https://storage.railway.app',
};

const MINIO_ENV = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'gather',
  S3_SECRET_KEY: 'gather-secret',
  S3_BUCKET: 'gather-media',
};

describe('s3 config sources', () => {
  it('reads a linked Railway bucket with no manual mapping', () => {
    const { s3 } = loadConfig({ NODE_ENV: 'test', ...RAILWAY_ENV });
    expect(s3.endpoint).toBe('https://storage.railway.app');
    expect(s3.bucket).toBe('gather-prod-bucket');
    expect(s3.accessKey).toBe('railway-key-id');
    expect(s3.secretKey).toBe('railway-secret-value');
    expect(s3.region).toBe('auto');
  });

  it('explicit S3_* wins over Railway names for every setting', () => {
    const { s3 } = loadConfig({
      NODE_ENV: 'test',
      ...RAILWAY_ENV,
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'hand-rolled',
      S3_ACCESS_KEY: 'hand-key',
      S3_SECRET_KEY: 'hand-secret',
      S3_REGION: 'eu-west-1',
    });
    expect(s3).toMatchObject({
      endpoint: 'http://minio:9000',
      bucket: 'hand-rolled',
      accessKey: 'hand-key',
      secretKey: 'hand-secret',
      region: 'eu-west-1',
    });
  });

  it('keeps the MinIO defaults when nothing is configured', () => {
    const { s3 } = loadConfig({ NODE_ENV: 'test' });
    expect(s3).toMatchObject({
      endpoint: 'http://localhost:9000',
      bucket: 'gather-media',
      region: 'us-east-1',
      pathStyle: true,
      publicBaseUrl: 'http://localhost:9000/gather-media',
    });
  });
});

describe('s3 addressing style', () => {
  it('Railway/Tigris endpoints resolve to virtual-hosted', () => {
    expect(loadConfig({ NODE_ENV: 'test', ...RAILWAY_ENV }).s3.pathStyle).toBe(false);
  });

  it('a hand-configured MinIO stays path-style', () => {
    expect(loadConfig({ NODE_ENV: 'test', ...MINIO_ENV }).s3.pathStyle).toBe(true);
    // Including MinIO behind a real domain, which needs MINIO_DOMAIN + wildcard
    // DNS before it can answer virtual-hosted requests.
    const env = { NODE_ENV: 'test', ...MINIO_ENV, S3_ENDPOINT: 'https://s3.example.com' };
    expect(loadConfig(env).s3.pathStyle).toBe(true);
  });

  it('S3_FORCE_PATH_STYLE overrides the derivation in both directions', () => {
    const forced = loadConfig({ NODE_ENV: 'test', ...RAILWAY_ENV, S3_FORCE_PATH_STYLE: 'true' });
    expect(forced.s3.pathStyle).toBe(true);
    const off = loadConfig({ NODE_ENV: 'test', ...MINIO_ENV, S3_FORCE_PATH_STYLE: 'false' });
    expect(off.s3.pathStyle).toBe(false);
  });

  it('rejects a non-boolean S3_FORCE_PATH_STYLE by name', () => {
    const env = { NODE_ENV: 'test', ...MINIO_ENV, S3_FORCE_PATH_STYLE: 'yes' };
    expect(() => loadConfig(env)).toThrow(/S3_FORCE_PATH_STYLE/);
  });
});

describe('public base url', () => {
  it('defaults to the virtual-hosted object base on Railway', () => {
    const { s3 } = loadConfig({ NODE_ENV: 'test', ...RAILWAY_ENV });
    expect(s3.publicBaseUrl).toBe('https://gather-prod-bucket.storage.railway.app');
    expect(new S3Storage(s3).publicUrl('hls/asset-1/master.m3u8')).toBe(
      'https://gather-prod-bucket.storage.railway.app/hls/asset-1/master.m3u8',
    );
  });

  it('defaults to endpoint/bucket when path-style', () => {
    const { s3 } = loadConfig({ NODE_ENV: 'test', ...MINIO_ENV, S3_BUCKET: 'media' });
    expect(s3.publicBaseUrl).toBe('http://localhost:9000/media');
  });

  it('an explicit S3_PUBLIC_BASE_URL (CDN) always wins', () => {
    const { s3 } = loadConfig({
      NODE_ENV: 'test',
      ...RAILWAY_ENV,
      S3_PUBLIC_BASE_URL: 'https://cdn.example.com/media',
    });
    expect(s3.publicBaseUrl).toBe('https://cdn.example.com/media');
  });
});

describe('the URL the client actually builds', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('presigns virtual-hosted PUTs against a Railway bucket', () => {
    const { s3, presignTtlSec } = loadConfig({ NODE_ENV: 'test', ...RAILWAY_ENV });
    const storage = new S3Storage(s3, presignTtlSec);
    const url = new URL(storage.presignUploadPart('src/a b.mp4', 'up-1', 2));
    expect(url.origin).toBe('https://gather-prod-bucket.storage.railway.app');
    // The bucket is the subdomain and MUST NOT also be in the path.
    expect(url.pathname).toBe('/src/a%20b.mp4');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('presigns path-style PUTs against MinIO', () => {
    const { s3, presignTtlSec } = loadConfig({ NODE_ENV: 'test', ...MINIO_ENV });
    const url = new URL(new S3Storage(s3, presignTtlSec).presignUploadPart('src/a.mp4', 'up-1', 1));
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/gather-media/src/a.mp4');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/us-east-1/s3/aws4_request');
  });

  it('signs control calls against the virtual-hosted host, not the endpoint', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init.headers) });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { s3 } = loadConfig({ NODE_ENV: 'test', ...RAILWAY_ENV });
    expect(await new S3Storage(s3).headObject('src/asset-1.mp4')).toBeNull();

    const call = calls[0];
    expect(call?.url).toBe('https://gather-prod-bucket.storage.railway.app/src/asset-1.mp4');
    // SigV4 signs `host` implicitly from the request URL — the credential scope
    // is what proves the region came from config rather than a hardcoded one.
    expect(call?.headers.get('authorization')).toContain('/auto/s3/aws4_request');
  });

  it('lists at the bucket root when virtual-hosted', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        urls.push(String(input));
        return new Response('<ListBucketResult></ListBucketResult>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      }),
    );

    const { s3 } = loadConfig({ NODE_ENV: 'test', ...RAILWAY_ENV });
    await new S3Storage(s3).deletePrefix('hls/asset-1/');
    expect(urls[0]).toContain('https://gather-prod-bucket.storage.railway.app/?list-type=2');
    expect(urls[0]).not.toContain('/gather-prod-bucket?');
  });
});

describe('fails closed instead of half-configuring', () => {
  it('rejects a partially linked bucket, naming both accepted spellings', () => {
    const env = {
      NODE_ENV: 'test',
      BUCKET: 'b',
      ACCESS_KEY_ID: 'k',
      ENDPOINT: 'https://t.tigris.dev',
    };
    let message = '';
    try {
      loadConfig(env);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('S3_SECRET_KEY or SECRET_ACCESS_KEY');
    expect(message).not.toContain('S3_BUCKET or BUCKET');
  });

  it('rejects a half-set S3_* config rather than mixing in dev defaults', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', S3_ENDPOINT: 'https://s3.example.com', S3_BUCKET: 'media' }),
    ).toThrow(/S3_ACCESS_KEY or ACCESS_KEY_ID/);
  });

  it('never puts a credential VALUE in the failure message', () => {
    const env = {
      NODE_ENV: 'test',
      ACCESS_KEY_ID: 'AKIA-not-a-real-key',
      SECRET_ACCESS_KEY: 'sh!',
    };
    let message = '';
    try {
      loadConfig(env);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/missing/);
    expect(message).not.toContain('AKIA-not-a-real-key');
    expect(message).not.toContain('sh!');
  });

  it('a production deploy running the pipeline must configure storage explicitly', () => {
    const base = {
      NODE_ENV: 'production',
      JWT_SECRET: 'production-secret-at-least-32-characters',
      ENABLE_MEDIA_PIPELINE: 'true',
    };
    expect(() => loadConfig(base)).toThrow(/incomplete object storage config/);
    expect(loadConfig({ ...base, ...RAILWAY_ENV }).s3.bucket).toBe('gather-prod-bucket');
  });

  it('a production deploy with the pipeline OFF still boots (P2P path, no S3)', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'production-secret-at-least-32-characters',
    });
    expect(config.enableMediaPipeline).toBe(false);
  });
});
