/**
 * Typed DataChannel fabric: labeled channels with JSON framing and typed
 * message unions, plus a backpressure guard so a slow peer cannot grow
 * memory unboundedly on the send side.
 *
 * IMPORTANT: these messages ride E2E-encrypted DataChannels directly between
 * peers — the server NEVER sees them, so they are deliberately defined here
 * (locally) and not in `@gather/contracts`.
 */

import type { UserId } from '@gather/contracts';
import type { DataChannelLike } from './types';

/**
 * The fixed set of channel labels the mesh negotiates per peer.
 *
 * THERE WAS A THIRD, `'emote'`, and it was removed 2026-08-19 because nothing
 * ever sent on it or subscribed to it. Emoji bursts have always travelled the
 * room WebSocket (`emote.burst`, ephemeral at seq 0) — which is the right
 * transport for them: a burst has to reach every member of the room including
 * the ones not in the call, and a peer channel only reaches peers. Negotiating
 * it per link cost a channel on every call and told a reader that emotes were
 * peer-to-peer.
 *
 * The two that remain stay negotiated even though neither carries traffic
 * today: `'file'` has a named consumer (fileshare.ts, ruled Go for 2.4), and
 * `'sync'` is the wire slot a future beacon transport would use — the
 * BeaconSender/BeaconFollower machinery itself was deleted with the master
 * clock (owner-authorized orphan cleanup), leaving only the SyncBeacon frame
 * and BeaconState shape below.
 */
export type ChannelLabel = 'sync' | 'file';

/** Fixed pre-negotiated DataChannel ids per label (both peers create the same id). */
export const CHANNEL_IDS: Record<ChannelLabel, number> = { sync: 0, file: 1 };

/** Playback snapshot a beacon carries (position/rate/playing, no clock).
 *  The BeaconSender/BeaconFollower machinery was deleted with the master
 *  clock; this shape survives only because apps/mobile's SyncTransport seam
 *  type pins it for the future p2p transport arm. */
export interface BeaconState {
  positionMs: number;
  rate: number;
  playing: boolean;
}

/** Master-clock beacon broadcast at 1 Hz + on every mutation. */
export interface SyncBeacon {
  t: 'beacon';
  positionMs: number;
  rate: number;
  playing: boolean;
  /** Master's local clock (ms) at send time. */
  masterTs: number;
  /** Election epoch of the sender; stale-epoch beacons are ignored. */
  epoch: number;
}

/** Messages carried on the sync channel. */
export type SyncChannelMessage = SyncBeacon;

/** Messages carried on the file channel (chunked P2P file transfer). */
export type FileChannelMessage =
  | { t: 'file.req'; fileId: string; offset: number; length: number }
  | { t: 'file.credit'; fileId: string; credits: number }
  | { t: 'file.chunk'; fileId: string; offset: number; dataB64: string; sha256?: string; eof: boolean }
  | { t: 'file.abort'; fileId: string }
  | { t: 'file.err'; fileId: string; code: 'NOT_FOUND' | 'RANGE' | 'INTERNAL' };

/** Label → message union carried on that channel. */
export interface ChannelMessages {
  sync: SyncChannelMessage;
  file: FileChannelMessage;
}

/** Options for {@link ChannelFabric}. */
export interface ChannelFabricOptions {
  /** Refuse sends while dc.bufferedAmount exceeds this (backpressure guard). Default 1_048_576. */
  maxBufferedBytes?: number;
}

/** Union of every message the fabric can carry. */
type AnyChannelMessage = ChannelMessages[ChannelLabel];

/** Handler stored per label; the label-keyed dispatch keeps the cast safe. */
type MessageHandler = (peerId: UserId, msg: AnyChannelMessage) => void;

/**
 * Owns the per-peer, per-label DataChannels of the mesh: framing, inbound
 * dispatch, open/close tracking, and backpressure. Malformed inbound data is
 * dropped silently — a hostile peer must not crash the fabric.
 */
export class ChannelFabric {
  private readonly maxBufferedBytes: number;
  private readonly channels = new Map<UserId, Map<ChannelLabel, DataChannelLike>>();
  private readonly messageSubs = new Map<ChannelLabel, Set<MessageHandler>>();
  private readonly openSubs = new Set<(peerId: UserId, label: ChannelLabel) => void>();
  private readonly drainWaiters = new Map<DataChannelLike, Set<() => void>>();

  constructor(opts?: ChannelFabricOptions) {
    this.maxBufferedBytes = opts?.maxBufferedBytes ?? 1_048_576;
  }

  /** Adopt a channel for a peer+label; installs onmessage/onopen/onclose handlers. */
  attach(peerId: UserId, label: ChannelLabel, dc: DataChannelLike): void {
    // Replacing an existing channel closes the old one: a renegotiated or
    // duplicate channel must not leave a zombie sending into the void.
    const existing = this.channels.get(peerId)?.get(label);
    if (existing !== undefined && existing !== dc) {
      this.closeChannel(existing);
    }

    let byLabel = this.channels.get(peerId);
    if (byLabel === undefined) {
      byLabel = new Map();
      this.channels.set(peerId, byLabel);
    }
    byLabel.set(label, dc);

    dc.bufferedAmountLowThreshold = Math.floor(this.maxBufferedBytes / 2);
    dc.onmessage = (ev) => this.handleMessage(peerId, label, ev.data);
    dc.onopen = () => this.emitOpen(peerId, label);
    dc.onbufferedamountlow = () => this.flushDrain(dc);
    dc.onclose = () => {
      // Forget the channel only if it is still the registered one; a
      // replacement already took the slot over.
      const current = this.channels.get(peerId);
      if (current?.get(label) === dc) {
        current.delete(label);
        if (current.size === 0) this.channels.delete(peerId);
      }
      this.flushDrain(dc);
    };

    // Pre-negotiated channels can already be open at attach time; their
    // onopen will never fire, so notify subscribers directly.
    if (dc.readyState === 'open') this.emitOpen(peerId, label);
  }

  /** Drop all channels for a peer (peer left / connection closed). Closes them. */
  detachPeer(peerId: UserId): void {
    const byLabel = this.channels.get(peerId);
    if (byLabel === undefined) return;
    this.channels.delete(peerId);
    for (const dc of byLabel.values()) this.closeChannel(dc);
  }

  /** True when the peer+label channel exists and is open. */
  isOpen(peerId: UserId, label: ChannelLabel): boolean {
    return this.channels.get(peerId)?.get(label)?.readyState === 'open';
  }

  /** JSON-frame and send. Returns false (and does not throw) when the channel is
   *  missing, not open, or over the backpressure threshold. */
  send<L extends ChannelLabel>(peerId: UserId, label: L, msg: ChannelMessages[L]): boolean {
    const dc = this.channels.get(peerId)?.get(label);
    if (dc === undefined || dc.readyState !== 'open') return false;
    if (dc.bufferedAmount > this.maxBufferedBytes) return false;
    dc.send(JSON.stringify(msg));
    return true;
  }

  /** Send to every open channel with that label; returns peers actually reached. */
  broadcast<L extends ChannelLabel>(label: L, msg: ChannelMessages[L]): UserId[] {
    const reached: UserId[] = [];
    for (const [peerId, byLabel] of this.channels) {
      if (byLabel.has(label) && this.send(peerId, label, msg)) reached.push(peerId);
    }
    return reached;
  }

  /** Resolves when bufferedAmount drops under threshold (immediately if already under,
   *  or if the channel is missing/closed). Uses onbufferedamountlow. */
  whenDrained(peerId: UserId, label: ChannelLabel): Promise<void> {
    const dc = this.channels.get(peerId)?.get(label);
    if (dc === undefined || dc.readyState !== 'open' || dc.bufferedAmount <= this.maxBufferedBytes) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let waiters = this.drainWaiters.get(dc);
      if (waiters === undefined) {
        waiters = new Set();
        this.drainWaiters.set(dc, waiters);
      }
      waiters.add(resolve);
    });
  }

  /** Subscribe to inbound messages on a label. Returns unsubscribe. */
  onMessage<L extends ChannelLabel>(
    label: L,
    fn: (peerId: UserId, msg: ChannelMessages[L]) => void,
  ): () => void {
    let subs = this.messageSubs.get(label);
    if (subs === undefined) {
      subs = new Set();
      this.messageSubs.set(label, subs);
    }
    // Safe because dispatch is keyed by the same label the handler bound to.
    const handler = fn as MessageHandler;
    subs.add(handler);
    return () => {
      subs.delete(handler);
    };
  }

  /** Subscribe to channel-open events. Returns unsubscribe. */
  onOpen(fn: (peerId: UserId, label: ChannelLabel) => void): () => void {
    this.openSubs.add(fn);
    return () => {
      this.openSubs.delete(fn);
    };
  }

  /** Peers whose channel for `label` is currently open. */
  peersWithOpen(label: ChannelLabel): UserId[] {
    const out: UserId[] = [];
    for (const [peerId, byLabel] of this.channels) {
      if (byLabel.get(label)?.readyState === 'open') out.push(peerId);
    }
    return out;
  }

  /** Close and forget everything. */
  close(): void {
    for (const byLabel of this.channels.values()) {
      for (const dc of byLabel.values()) this.closeChannel(dc);
    }
    this.channels.clear();
    this.messageSubs.clear();
    this.openSubs.clear();
  }

  private handleMessage(peerId: UserId, label: ChannelLabel, data: unknown): void {
    // Only string frames are valid; anything else (binary, garbage JSON, a
    // non-object or a missing `t`) is dropped silently.
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    if (typeof (parsed as { t?: unknown }).t !== 'string') return;
    const subs = this.messageSubs.get(label);
    if (subs === undefined) return;
    const msg = parsed as AnyChannelMessage;
    for (const fn of [...subs]) fn(peerId, msg);
  }

  private emitOpen(peerId: UserId, label: ChannelLabel): void {
    // Snapshot: a subscriber may unsubscribe (or attach more) mid-dispatch.
    for (const fn of [...this.openSubs]) fn(peerId, label);
  }

  private flushDrain(dc: DataChannelLike): void {
    const waiters = this.drainWaiters.get(dc);
    if (waiters === undefined) return;
    this.drainWaiters.delete(dc);
    for (const resolve of waiters) resolve();
  }

  private closeChannel(dc: DataChannelLike): void {
    dc.onopen = null;
    dc.onclose = null;
    dc.onmessage = null;
    dc.onbufferedamountlow = null;
    // Pending drain waiters resolve on close: waiting on a dead channel
    // would hang the sender forever.
    this.flushDrain(dc);
    dc.close();
  }
}
