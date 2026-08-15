/**
 * P2P file serving over the 'file' DataChannel: the owner slices registered
 * files into 64 KiB chunks and streams them under credit-based flow control,
 * while consumers drive the transfer with prioritized chunk requests centered
 * on their playhead (seek window).
 *
 * Framing is the {@link FileChannelMessage} union from channels.ts; chunk
 * payloads are base64 via the internal b64 codec (no platform codecs exist in
 * this package).
 */

import type { UserId } from '@playin/contracts';
import { base64ToBytes, bytesToBase64 } from './b64';
import type { FileChannelMessage } from './channels';
import type { ClearTimeoutFn, SetTimeoutFn, TimeoutHandle } from './types';

/** Chunk payload size in bytes. */
export const FILE_CHUNK_SIZE = 65_536;

/** Default per-consumer send window, in chunks. */
export const FILE_WINDOW_CHUNKS = 32;

/** Async chunk source backing a served file (memory, OPFS, RN file handle...). */
export interface FileSource {
  sizeBytes: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Injected content hash (e.g. WebCrypto SHA-256 → hex) — optional integrity. */
export type HashFn = (data: Uint8Array) => Promise<string>;

/** A queued range request, mutated as pieces are sent. */
interface PendingRequest {
  fileId: string;
  offset: number;
  length: number;
}

/** Per-consumer server state. */
interface ConsumerState {
  /** FIFO of pending ranges; the head is sliced into chunkSize pieces. */
  queue: PendingRequest[];
  /** Remaining send credits; refreshed consumers start with a full window. */
  credits: number;
}

/** Options for {@link FileShareServer}. */
export interface FileShareServerOptions {
  /** Typically (peerId, msg) => fabric.send(peerId, 'file', msg). May return false
   *  under backpressure — the server retries on a timer. */
  send: (peerId: UserId, msg: FileChannelMessage) => boolean;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  chunkSize?: number;
  windowChunks?: number;
  hash?: HashFn;
  /** Delay before retrying a send the transport refused. Default 25. */
  retryMs?: number;
  onError?: (peerId: UserId, err: unknown) => void;
}

/** The chunk message variant of the file-channel union. */
type FileChunk = Extract<FileChannelMessage, { t: 'file.chunk' }>;

/** Owner side: serves registered files to any number of mesh consumers. */
export class FileShareServer {
  private readonly send: (peerId: UserId, msg: FileChannelMessage) => boolean;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly chunkSize: number;
  private readonly windowChunks: number;
  private readonly hash: HashFn | undefined;
  private readonly retryMs: number;
  private readonly onError: (peerId: UserId, err: unknown) => void;

  private readonly files = new Map<string, FileSource>();
  private readonly consumers = new Map<UserId, ConsumerState>();
  /** Rotation cursor for round-robin fairness across consumers. */
  private rrOffset = 0;
  private pumping = false;
  private retryTimer: TimeoutHandle | null = null;
  private closed = false;

  constructor(opts: FileShareServerOptions) {
    this.send = opts.send;
    this.setTimeoutFn = opts.setTimeoutFn;
    this.clearTimeoutFn = opts.clearTimeoutFn;
    this.chunkSize = opts.chunkSize ?? FILE_CHUNK_SIZE;
    this.windowChunks = opts.windowChunks ?? FILE_WINDOW_CHUNKS;
    this.hash = opts.hash;
    this.retryMs = opts.retryMs ?? 25;
    this.onError = opts.onError ?? (() => {});
  }

  /** Register (or replace) a servable file. */
  register(fileId: string, source: FileSource): void {
    this.files.set(fileId, source);
  }

  /** Stop serving a file; queued requests for it fail with NOT_FOUND. */
  unregister(fileId: string): void {
    this.files.delete(fileId);
  }

  /** Wire to fabric.onMessage('file', ...). Handles file.req / file.credit / file.abort. */
  handleMessage(peerId: UserId, msg: FileChannelMessage): void {
    if (this.closed) return;
    switch (msg.t) {
      case 'file.req': {
        const source = this.files.get(msg.fileId);
        if (source === undefined) {
          this.send(peerId, { t: 'file.err', fileId: msg.fileId, code: 'NOT_FOUND' });
          return;
        }
        if (msg.offset < 0 || msg.length <= 0 || msg.offset + msg.length > source.sizeBytes) {
          this.send(peerId, { t: 'file.err', fileId: msg.fileId, code: 'RANGE' });
          return;
        }
        const consumer = this.consumer(peerId);
        consumer.queue.push({ fileId: msg.fileId, offset: msg.offset, length: msg.length });
        this.kickPump();
        return;
      }
      case 'file.credit': {
        const consumer = this.consumer(peerId);
        consumer.credits = Math.min(this.windowChunks, consumer.credits + msg.credits);
        this.kickPump();
        return;
      }
      case 'file.abort': {
        const consumer = this.consumers.get(peerId);
        if (consumer === undefined) return;
        consumer.queue = consumer.queue.filter((r) => r.fileId !== msg.fileId);
        return;
      }
      default:
        // file.chunk / file.err are consumer-side messages; ignore.
        return;
    }
  }

  /** Forget all queued work + credits for a departed consumer. */
  peerLeft(peerId: UserId): void {
    this.consumers.delete(peerId);
  }

  /** True when no requests are queued or in flight (test hook). */
  idle(): boolean {
    if (this.pumping) return false;
    for (const consumer of this.consumers.values()) {
      if (consumer.queue.length > 0) return false;
    }
    return true;
  }

  /** Stop pumping, cancel the retry timer, and forget everything. */
  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) {
      this.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }
    this.consumers.clear();
    this.files.clear();
  }

  // ---------- pump internals ----------

  private consumer(peerId: UserId): ConsumerState {
    let consumer = this.consumers.get(peerId);
    if (consumer === undefined) {
      consumer = { queue: [], credits: this.windowChunks };
      this.consumers.set(peerId, consumer);
    }
    return consumer;
  }

  private kickPump(): void {
    if (this.closed || this.pumping || this.retryTimer !== null) return;
    void this.pump();
  }

  /** Single-flight pump: cycle consumers round-robin, one chunk per turn,
   *  until nobody can make progress. Pauses on transport backpressure. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        let progressed = false;
        const entries = [...this.consumers.entries()];
        if (entries.length === 0) return;
        const offset = this.rrOffset % entries.length;
        const rotated = entries.slice(offset).concat(entries.slice(0, offset));
        for (const [peerId, consumer] of rotated) {
          if (this.closed) return;
          if (consumer.credits <= 0 || consumer.queue.length === 0) continue;
          const outcome = await this.sendNextPiece(peerId, consumer);
          if (outcome === 'backpressured') {
            this.scheduleRetry();
            return;
          }
          progressed = true;
          this.rrOffset += 1;
        }
        if (!progressed) return;
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Send the next chunkSize piece of the consumer's head request. Returns
   *  'sent', 'dropped' (request failed), or 'backpressured' (transport refused —
   *  no credit consumed, retry on timer). */
  private async sendNextPiece(
    peerId: UserId,
    consumer: ConsumerState,
  ): Promise<'sent' | 'dropped' | 'backpressured'> {
    const head = consumer.queue[0];
    if (head === undefined) return 'dropped';
    const source = this.files.get(head.fileId);
    if (source === undefined) {
      // Unregistered after the request was queued.
      this.send(peerId, { t: 'file.err', fileId: head.fileId, code: 'NOT_FOUND' });
      consumer.queue.shift();
      return 'dropped';
    }
    const pieceLength = Math.min(this.chunkSize, head.length);
    let data: Uint8Array;
    let sha256: string | null = null;
    try {
      data = await source.read(head.offset, pieceLength);
      if (this.hash !== undefined) sha256 = await this.hash(data);
    } catch (err) {
      this.send(peerId, { t: 'file.err', fileId: head.fileId, code: 'INTERNAL' });
      consumer.queue.shift();
      this.onError(peerId, err);
      return 'dropped';
    }
    const chunk: FileChunk = {
      t: 'file.chunk',
      fileId: head.fileId,
      offset: head.offset,
      dataB64: bytesToBase64(data),
      eof: pieceLength >= head.length,
    };
    if (sha256 !== null) chunk.sha256 = sha256;
    if (!this.send(peerId, chunk)) return 'backpressured';
    consumer.credits -= 1;
    head.offset += pieceLength;
    head.length -= pieceLength;
    if (head.length === 0) consumer.queue.shift();
    return 'sent';
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      this.kickPump();
    }, this.retryMs);
  }
}

/** Options for {@link FileShareClient}. */
export interface FileShareClientOptions {
  /** Send toward the file owner (single peer). May return false; client retries. */
  send: (msg: FileChannelMessage) => boolean;
  setTimeoutFn: SetTimeoutFn;
  clearTimeoutFn: ClearTimeoutFn;
  chunkSize?: number;
  windowChunks?: number;
  hash?: HashFn;
  /** Re-issue a chunk request if unanswered after this long. Default 1500. */
  requestTimeoutMs?: number;
  onError?: (err: unknown) => void;
}

/** Delay before retrying a send the transport refused. */
const CLIENT_RETRY_MS = 25;

/** One active download. */
interface DownloadState {
  fileId: string;
  sizeBytes: number;
  totalChunks: number;
  /** Playhead byte offset steering request priority. */
  playhead: number;
  /** Chunk offsets not yet requested. */
  needed: Set<number>;
  /** Chunk offsets requested but not yet received, with their timeout handle. */
  inflight: Map<number, TimeoutHandle>;
  /** Received chunk bytes by absolute offset. */
  received: Map<number, Uint8Array>;
  /** Credits owed to the server (accumulated, flushed promptly). */
  pendingCredits: number;
  retryTimer: TimeoutHandle | null;
  onChunk: ((offset: number, bytes: Uint8Array) => void) | undefined;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: unknown) => void;
}

/** Consumer side: downloads a file as prioritized 64 KiB chunk requests with a
 *  sliding request window, replenishing server credits as chunks arrive. */
export class FileShareClient {
  private readonly send: (msg: FileChannelMessage) => boolean;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly chunkSize: number;
  private readonly windowChunks: number;
  private readonly hash: HashFn | undefined;
  private readonly requestTimeoutMs: number;
  private readonly onError: (err: unknown) => void;

  private readonly downloads = new Map<string, DownloadState>();
  private closed = false;

  constructor(opts: FileShareClientOptions) {
    this.send = opts.send;
    this.setTimeoutFn = opts.setTimeoutFn;
    this.clearTimeoutFn = opts.clearTimeoutFn;
    this.chunkSize = opts.chunkSize ?? FILE_CHUNK_SIZE;
    this.windowChunks = opts.windowChunks ?? FILE_WINDOW_CHUNKS;
    this.hash = opts.hash;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 1500;
    this.onError = opts.onError ?? (() => {});
  }

  /** Wire to fabric.onMessage('file', ...) filtered to the owner peer. */
  handleMessage(msg: FileChannelMessage): void {
    if (this.closed) return;
    switch (msg.t) {
      case 'file.chunk': {
        const state = this.downloads.get(msg.fileId);
        if (state === undefined) return;
        void this.handleChunk(state, msg);
        return;
      }
      case 'file.err': {
        const state = this.downloads.get(msg.fileId);
        if (state === undefined) return;
        this.teardown(state);
        state.reject(new Error(`file error: ${msg.code}`));
        return;
      }
      default:
        return;
    }
  }

  /** Download the whole file. Chunk requests are issued nearest-to-playhead first
   *  (forward of the playhead before behind it). Resolves with the assembled bytes. */
  download(
    fileId: string,
    sizeBytes: number,
    opts?: { onChunk?: (offset: number, bytes: Uint8Array) => void },
  ): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error('closed'));
    if (this.downloads.has(fileId)) {
      return Promise.reject(new Error('download already in progress'));
    }
    if (sizeBytes <= 0) return Promise.resolve(new Uint8Array(0));
    const totalChunks = Math.ceil(sizeBytes / this.chunkSize);
    const needed = new Set<number>();
    for (let i = 0; i < totalChunks; i += 1) needed.add(i * this.chunkSize);
    return new Promise<Uint8Array>((resolve, reject) => {
      const state: DownloadState = {
        fileId,
        sizeBytes,
        totalChunks,
        playhead: 0,
        needed,
        inflight: new Map(),
        received: new Map(),
        pendingCredits: 0,
        retryTimer: null,
        onChunk: opts?.onChunk,
        resolve,
        reject,
      };
      this.downloads.set(fileId, state);
      this.topUp(state);
    });
  }

  /** Move the seek window: unrequested chunks are re-prioritized around the new
   *  playhead byte offset. In-flight requests are left alone. */
  setPlayhead(fileId: string, byteOffset: number): void {
    const state = this.downloads.get(fileId);
    if (state === undefined) return;
    state.playhead = Math.max(0, Math.min(byteOffset, state.sizeBytes));
    // `needed` is re-sorted lazily on every pick, so nothing else to do.
  }

  /** Abort an active download; its promise rejects with Error('aborted'). */
  cancel(fileId: string): void {
    const state = this.downloads.get(fileId);
    if (state === undefined) return;
    this.teardown(state);
    state.reject(new Error('aborted'));
  }

  /** Abort every active download and stop accepting new ones. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of [...this.downloads.values()]) {
      this.teardown(state);
      state.reject(new Error('closed'));
    }
  }

  // ---------- request window internals ----------

  /** Refill the sliding window: issue requests until windowChunks are inflight
   *  or nothing is left to request. Pauses on transport backpressure. */
  private topUp(state: DownloadState): void {
    if (this.closed || this.downloads.get(state.fileId) !== state) return;
    while (state.inflight.size < this.windowChunks && state.needed.size > 0) {
      const offset = this.pickNext(state);
      if (offset === undefined) return;
      const length = Math.min(this.chunkSize, state.sizeBytes - offset);
      const ok = this.send({ t: 'file.req', fileId: state.fileId, offset, length });
      if (!ok) {
        // Keep the chunk in `needed`; retry on a short timer.
        this.scheduleRetry(state);
        return;
      }
      state.needed.delete(offset);
      state.inflight.set(offset, this.armTimeout(state, offset));
    }
  }

  /** Next needed offset by seek-window priority: forward-of-playhead ascending,
   *  then behind-playhead ascending (both by the same wrap-around distance). */
  private pickNext(state: DownloadState): number | undefined {
    let best: number | undefined;
    let bestKey = Number.POSITIVE_INFINITY;
    for (const offset of state.needed) {
      const key =
        offset >= state.playhead
          ? offset - state.playhead
          : state.sizeBytes - state.playhead + (state.playhead - offset);
      if (key < bestKey) {
        bestKey = key;
        best = offset;
      }
    }
    return best;
  }

  private armTimeout(state: DownloadState, offset: number): TimeoutHandle {
    return this.setTimeoutFn(() => {
      if (this.downloads.get(state.fileId) !== state) return;
      if (state.inflight.delete(offset)) {
        state.needed.add(offset);
        this.topUp(state);
      }
    }, this.requestTimeoutMs);
  }

  private async handleChunk(state: DownloadState, msg: FileChunk): Promise<void> {
    const timeout = state.inflight.get(msg.offset);
    if (timeout === undefined) {
      // Duplicate (e.g. arrived after its timeout re-issued the request's slot)
      // or for an offset we never asked for: ignore.
      return;
    }
    const fail = (): void => {
      if (this.downloads.get(state.fileId) !== state) return;
      this.clearTimeoutFn(timeout);
      state.inflight.delete(msg.offset);
      state.needed.add(msg.offset);
      this.topUp(state);
    };
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(msg.dataB64);
    } catch {
      fail();
      return;
    }
    const expectedLength = Math.min(this.chunkSize, state.sizeBytes - msg.offset);
    if (bytes.length !== expectedLength) {
      fail();
      return;
    }
    if (this.hash !== undefined && msg.sha256 !== undefined) {
      let digest: string;
      try {
        digest = await this.hash(bytes);
      } catch (err) {
        this.onError(err);
        fail();
        return;
      }
      if (this.downloads.get(state.fileId) !== state) return;
      if (digest !== msg.sha256) {
        fail();
        return;
      }
    }
    this.clearTimeoutFn(timeout);
    state.inflight.delete(msg.offset);
    state.received.set(msg.offset, bytes);
    state.onChunk?.(msg.offset, bytes);
    state.pendingCredits += 1;
    this.flushCredits(state);
    if (state.received.size === state.totalChunks) {
      const assembled = new Uint8Array(state.sizeBytes);
      for (let i = 0; i < state.totalChunks; i += 1) {
        const piece = state.received.get(i * this.chunkSize);
        if (piece !== undefined) assembled.set(piece, i * this.chunkSize);
      }
      this.teardown(state);
      state.resolve(assembled);
      return;
    }
    this.topUp(state);
  }

  /** Grant accumulated credits back to the owner; retry on backpressure. */
  private flushCredits(state: DownloadState): void {
    if (state.pendingCredits === 0) return;
    if (this.downloads.get(state.fileId) !== state) return;
    const ok = this.send({
      t: 'file.credit',
      fileId: state.fileId,
      credits: state.pendingCredits,
    });
    if (ok) {
      state.pendingCredits = 0;
    } else {
      this.scheduleRetry(state);
    }
  }

  private scheduleRetry(state: DownloadState): void {
    if (state.retryTimer !== null) return;
    state.retryTimer = this.setTimeoutFn(() => {
      state.retryTimer = null;
      if (this.downloads.get(state.fileId) !== state) return;
      this.flushCredits(state);
      this.topUp(state);
    }, CLIENT_RETRY_MS);
  }

  /** Cancel timers and forget the download. Does not settle its promise. */
  private teardown(state: DownloadState): void {
    for (const timeout of state.inflight.values()) this.clearTimeoutFn(timeout);
    state.inflight.clear();
    if (state.retryTimer !== null) {
      this.clearTimeoutFn(state.retryTimer);
      state.retryTimer = null;
    }
    this.downloads.delete(state.fileId);
  }
}
