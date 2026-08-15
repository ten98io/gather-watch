import { describe, expect, it } from 'vitest';
import { ChunkedUploader, UploadError } from '../src';
import type {
  FetchLike,
  FetchResponseLike,
  RestClient,
  SetTimeoutFn,
  UploadProgress,
  UploadSource,
} from '../src';
import { tick } from './helpers';

const makeRest = (partCount: number) => {
  const createCalls: unknown[] = [];
  const completeCalls: {
    assetId: unknown;
    uploadId: unknown;
    parts: { partNumber: number; etag: string }[];
  }[] = [];
  const rest = {
    media: {
      createUpload: async (body: unknown) => {
        createCalls.push(body);
        return {
          assetId: 'a1',
          uploadId: 'up1',
          parts: Array.from({ length: partCount }, (_, i) => ({
            partNumber: i + 1,
            url: `http://s3.test/part/${i + 1}`,
          })),
        };
      },
      completeUpload: async (body: never) => {
        completeCalls.push(body);
        return { asset: { id: 'a1' } };
      },
    },
  } as unknown as RestClient;
  return { rest, createCalls, completeCalls };
};

const makeSource = (sizeBytes: number): UploadSource => ({
  filename: 'f.bin',
  mime: 'application/octet-stream',
  sizeBytes,
  readPart: async (s, e) => new Uint8Array(e - s),
});

/** Etag response whose tag derives from the url's trailing part number. */
const etagResponse = (url: string): FetchResponseLike => {
  const n = url.slice(url.lastIndexOf('/') + 1);
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? `"etag-${n}"` : null) },
    json: async () => ({}),
    text: async () => '',
  };
};

// Immediate retries — no timers to manage.
const immediate: SetTimeoutFn = ((fn: () => void) => {
  fn();
  return 0;
}) as SetTimeoutFn;

describe('ChunkedUploader', () => {
  it('uploads all parts, strips etag quotes, completes with sorted parts, reports monotonic progress', async () => {
    const { rest, completeCalls } = makeRest(3);
    const bodyLengths: number[] = [];
    const putFetch: FetchLike = async (url, init) => {
      bodyLengths.push((init?.body as Uint8Array).length);
      return etagResponse(url);
    };
    const progress: UploadProgress[] = [];
    const uploader = new ChunkedUploader(rest, {
      fetchImpl: putFetch,
      retryDelayMs: 0,
      setTimeoutFn: immediate,
      onProgress: (p) => {
        progress.push(p);
      },
    });
    // partSize = ceil(10/3) = 4 -> ranges [0,4), [4,8), [8,10).
    const asset = await uploader.upload(makeSource(10));
    expect((asset as { id: string }).id).toBe('a1');
    // Completion order may vary across workers; compare sorted.
    expect([...bodyLengths].sort((a, b) => a - b)).toEqual([2, 4, 4]);
    expect(completeCalls[0]!.parts).toEqual([
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
      { partNumber: 3, etag: 'etag-3' },
    ]);
    expect(progress.map((p) => p.partsCompleted)).toEqual([1, 2, 3]);
    expect(progress[progress.length - 1]!).toEqual({
      uploadedBytes: 10,
      totalBytes: 10,
      partsCompleted: 3,
      partsTotal: 3,
      fraction: 1,
    });
  });

  it('retries a failing part up to 3 attempts then succeeds', async () => {
    const { rest, completeCalls } = makeRest(3);
    const putUrls: string[] = [];
    const attemptsByUrl = new Map<string, number>();
    const putFetch: FetchLike = (url) => {
      putUrls.push(url);
      const n = (attemptsByUrl.get(url) ?? 0) + 1;
      attemptsByUrl.set(url, n);
      if (url.endsWith('/part/2') && n < 3) return Promise.reject(new Error('boom'));
      return Promise.resolve(etagResponse(url));
    };
    const uploader = new ChunkedUploader(rest, {
      fetchImpl: putFetch,
      retryDelayMs: 0,
      setTimeoutFn: immediate,
    });
    await uploader.upload(makeSource(12));
    // Parts 1 and 3 once each, part 2 three times.
    expect(putUrls.length).toBe(5);
    expect(completeCalls.length).toBe(1);
  });

  it('fails the upload after exhausting part retries', async () => {
    const { rest, completeCalls } = makeRest(3);
    let part2Calls = 0;
    const putFetch: FetchLike = (url) => {
      if (url.endsWith('/part/2')) {
        part2Calls += 1;
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(etagResponse(url));
    };
    const uploader = new ChunkedUploader(rest, {
      fetchImpl: putFetch,
      retryDelayMs: 0,
      setTimeoutFn: immediate,
    });
    const p = uploader.upload(makeSource(12));
    await expect(p).rejects.toBeInstanceOf(UploadError);
    await expect(p).rejects.toMatchObject({ partNumber: 2 });
    await expect(p).rejects.toThrow('after 3 attempts');
    expect(completeCalls).toEqual([]);
    expect(part2Calls).toBe(3);
  });

  it('never runs more than 4 parts concurrently', async () => {
    const { rest, completeCalls } = makeRest(8);
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: (() => void)[] = [];
    const putFetch: FetchLike = (url) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<FetchResponseLike>((resolve) => {
        releases.push(() => {
          inFlight -= 1;
          resolve(etagResponse(url));
        });
      });
    };
    const uploader = new ChunkedUploader(rest, {
      fetchImpl: putFetch,
      retryDelayMs: 0,
      setTimeoutFn: immediate,
    });
    const p = uploader.upload(makeSource(800));
    await tick();
    expect(releases.length).toBe(4);
    expect(maxInFlight).toBe(4);
    const wave1 = releases.splice(0, releases.length);
    for (const release of wave1) release();
    await tick();
    expect(releases.length).toBe(4);
    const wave2 = releases.splice(0, releases.length);
    for (const release of wave2) release();
    await p;
    expect(maxInFlight).toBe(4);
    expect(completeCalls.length).toBe(1);
  });

  it('fails fast with an actionable error when a part PUT exposes no ETag (CORS ExposeHeaders)', async () => {
    const { rest, completeCalls } = makeRest(2);
    // ok:true but no etag header — the classic missing ExposeHeaders setup.
    const putFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => '',
    });
    const uploader = new ChunkedUploader(rest, {
      fetchImpl: putFetch,
      retryDelayMs: 0,
      setTimeoutFn: immediate,
    });
    const p = uploader.upload(makeSource(8));
    await expect(p).rejects.toBeInstanceOf(UploadError);
    await expect(p).rejects.toThrow('no ETag was exposed');
    await expect(p).rejects.toThrow('ExposeHeaders');
    // Never reaches completeUpload with an empty etag (contract requires min(1)).
    expect(completeCalls).toEqual([]);
  });

  it('uses server-provided byte ranges when present instead of the ceil-split convention', async () => {
    const completeCalls: unknown[] = [];
    const rest = {
      media: {
        createUpload: async () => ({
          assetId: 'a1',
          uploadId: 'up1',
          // Deliberately NOT the ceil split of 12 bytes across 2 parts (6/6):
          // server dictates 10 + 2.
          parts: [
            { partNumber: 1, url: 'http://s3.test/part/1', startByte: 0, endByte: 10 },
            { partNumber: 2, url: 'http://s3.test/part/2', startByte: 10, endByte: 12 },
          ],
        }),
        completeUpload: async (body: never) => {
          completeCalls.push(body);
          return { asset: { id: 'a1' } };
        },
      },
    } as unknown as RestClient;
    const reads: [number, number][] = [];
    const source: UploadSource = {
      filename: 'f.bin',
      mime: 'application/octet-stream',
      sizeBytes: 12,
      readPart: async (s, e) => {
        reads.push([s, e]);
        return new Uint8Array(e - s);
      },
    };
    const uploader = new ChunkedUploader(rest, {
      fetchImpl: async (url) => etagResponse(url),
      retryDelayMs: 0,
      setTimeoutFn: immediate,
      concurrency: 1,
    });
    await uploader.upload(source);
    expect(reads).toEqual([
      [0, 10],
      [10, 12],
    ]);
    expect(completeCalls.length).toBe(1);
  });

  it('rejects a second concurrent upload', async () => {
    const { rest } = makeRest(2);
    // A PUT that never resolves.
    const putFetch: FetchLike = () => new Promise<FetchResponseLike>(() => {});
    const uploader = new ChunkedUploader(rest, {
      fetchImpl: putFetch,
      retryDelayMs: 0,
      setTimeoutFn: immediate,
    });
    const src = makeSource(8);
    const first = uploader.upload(src);
    await tick(); // workers are now parked on the never-resolving PUTs
    const second = uploader.upload(src);
    await expect(second).rejects.toBeInstanceOf(UploadError);
    await expect(second).rejects.toMatchObject({ message: 'upload already in progress' });
    // abort() must settle the upload promptly even with part PUTs still in flight.
    uploader.abort();
    await expect(first).rejects.toBeInstanceOf(UploadError);
    await expect(first).rejects.toMatchObject({ message: 'aborted' });
  });
});
