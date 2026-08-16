/**
 * Mock RTC world for @gather/p2p tests: a virtual clock, a seedable PRNG, a
 * scripted-SDP mock RTCPeerConnection with the exact signaling-state semantics
 * the production code relies on (implicit rollback, addIceCandidate guards),
 * virtual DataChannels with fault injection, and an in-memory signaling hub
 * that emulates the room WS relay. Fully deterministic — no real timers, no
 * Date.now, no Math.random.
 */

import type { IceCandidateInit, RoomId, UserId } from '@gather/contracts';
import type {
  ClearTimeoutFn,
  ConnectionStateLike,
  DataChannelInitLike,
  DataChannelLike,
  InboundSignal,
  MediaStreamTrackLike,
  OutboundSignal,
  RtcConfigLike,
  RtcFactory,
  RtcPeerConnectionLike,
  RtpParametersLike,
  RtpSenderLike,
  SessionDescriptionLike,
  SetTimeoutFn,
  SignalingStateLike,
} from '../src/types';

/** Brand a plain string as a UserId (tests only). */
export const uid = (s: string): UserId => s as UserId;

/** Brand a plain string as a RoomId (tests only). */
export const rid = (s: string): RoomId => s as RoomId;

/** Deterministic seedable PRNG (mulberry32), floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScheduledTimer {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

/** Virtual time: ordered timer wheel + microtask draining. */
export class VirtualClock {
  private timeMs = 1_000_000;
  private seq = 0;
  private timers: ScheduledTimer[] = [];

  /** Current virtual time in ms (starts at 1,000,000). */
  now(): number {
    return this.timeMs;
  }

  readonly setTimeoutFn: SetTimeoutFn = (fn, ms) => {
    const timer: ScheduledTimer = {
      at: this.timeMs + Math.max(0, ms),
      seq: this.seq++,
      fn,
      cancelled: false,
    };
    this.timers.push(timer);
    return timer;
  };

  readonly clearTimeoutFn: ClearTimeoutFn = (handle) => {
    const timer = handle as ScheduledTimer | null;
    if (timer !== null && typeof timer === 'object') timer.cancelled = true;
  };

  /** Drain microtasks without moving time. */
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  /** Advance virtual time, firing due timers in (time, insertion) order and
   *  draining microtasks after each so promise chains settle deterministically. */
  async advance(ms: number): Promise<void> {
    const target = this.timeMs + ms;
    await this.flush();
    for (;;) {
      const next = this.nextDue(target);
      if (next === null) break;
      this.timeMs = Math.max(this.timeMs, next.at);
      if (!next.cancelled) next.fn();
      await this.flush();
    }
    this.timeMs = target;
    await this.flush();
  }

  private nextDue(limit: number): ScheduledTimer | null {
    let best: ScheduledTimer | null = null;
    let bestIndex = -1;
    for (let i = 0; i < this.timers.length; i += 1) {
      const t = this.timers[i] as ScheduledTimer;
      if (t.cancelled) continue;
      if (t.at > limit) continue;
      if (best === null || t.at < best.at || (t.at === best.at && t.seq < best.seq)) {
        best = t;
        bestIndex = i;
      }
    }
    if (best === null) {
      this.timers = this.timers.filter((t) => !t.cancelled);
      return null;
    }
    this.timers.splice(bestIndex, 1);
    return best;
  }
}

/** Per-link fault knobs for DataChannel traffic (both directions). */
export interface LinkFaults {
  /** Probability [0,1] a channel message is silently dropped. Default 0. */
  dropRate?: number;
  /** One-way channel delivery delay in ms. Default 5. */
  delayMs?: number;
  /** Extra uniform jitter (+/- half) added to delayMs. Default 0. */
  jitterMs?: number;
}

interface ResolvedFaults {
  dropRate: number;
  delayMs: number;
  jitterMs: number;
}

const DEFAULT_FAULTS: ResolvedFaults = { dropRate: 0, delayMs: 5, jitterMs: 0 };

function resolveFaults(f?: LinkFaults): ResolvedFaults {
  return {
    dropRate: f?.dropRate ?? DEFAULT_FAULTS.dropRate,
    delayMs: f?.delayMs ?? DEFAULT_FAULTS.delayMs,
    jitterMs: f?.jitterMs ?? DEFAULT_FAULTS.jitterMs,
  };
}

/** Virtual DataChannel; pairs with a counterpart for delivery. */
export class MockDataChannel implements DataChannelLike {
  readonly label: string;
  readonly channelId: number;
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;

  /** Counterpart channel; set when the pair opens. */
  peer: MockDataChannel | null = null;
  /** Fault config used for messages this side sends. */
  faults: ResolvedFaults = DEFAULT_FAULTS;

  private readonly clock: VirtualClock;
  private readonly rng: () => number;

  constructor(
    clock: VirtualClock,
    rng: () => number,
    label: string,
    channelId: number,
  ) {
    this.clock = clock;
    this.rng = rng;
    this.label = label;
    this.channelId = channelId;
  }

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('channel not open');
    this.bufferedAmount += data.length;
    const target = this.peer;
    const faults = this.faults;
    const jitter = faults.jitterMs > 0 ? (this.rng() - 0.5) * faults.jitterMs : 0;
    const delay = Math.max(0, faults.delayMs + jitter);
    const dropped = faults.dropRate > 0 && this.rng() < faults.dropRate;
    // Buffered bytes drain on a 1ms timer whether or not the message survives.
    this.clock.setTimeoutFn(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount = Math.max(0, this.bufferedAmount - data.length);
      if (
        before > this.bufferedAmountLowThreshold &&
        this.bufferedAmount <= this.bufferedAmountLowThreshold
      ) {
        this.onbufferedamountlow?.();
      }
    }, 1);
    if (dropped) return;
    this.clock.setTimeoutFn(() => {
      if (target === null || target.readyState !== 'open') return;
      target.onmessage?.({ data });
    }, delay);
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    const target = this.peer;
    if (target !== null && target.readyState !== 'closed') {
      this.clock.setTimeoutFn(() => {
        if (target.readyState === 'closed') return;
        target.readyState = 'closed';
        target.onclose?.();
      }, 1);
    }
  }

  /** Open this end (harness only). */
  forceOpen(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this.onopen?.();
  }
}

/** Sender mock recording parameter updates. */
export class MockRtpSender implements RtpSenderLike {
  track: MediaStreamTrackLike | null;
  appliedParameters: RtpParametersLike[] = [];
  private parameters: RtpParametersLike = { encodings: [{}] };

  constructor(track: MediaStreamTrackLike) {
    this.track = track;
  }

  getParameters(): RtpParametersLike {
    return this.parameters;
  }

  setParameters(parameters: RtpParametersLike): Promise<void> {
    this.parameters = parameters;
    this.appliedParameters.push(parameters);
    return Promise.resolve();
  }

  replaceTrack(track: MediaStreamTrackLike | null): Promise<void> {
    this.track = track;
    return Promise.resolve();
  }
}

/** Extract the pc id embedded in a scripted SDP string, or null. */
function pcIdFromSdp(sdp: string | undefined): number | null {
  if (sdp === undefined) return null;
  const parts = sdp.split(':');
  const idPart = parts[1];
  if (idPart === undefined) return null;
  const id = Number(idPart);
  return Number.isFinite(id) ? id : null;
}

/**
 * Scripted-SDP RTCPeerConnection mock implementing the exact state-machine
 * behaviors production relies on: implicit rollback for a remote offer in
 * have-local-offer, InvalidStateError for stray answers and for
 * addIceCandidate without a remote description, and coalesced
 * negotiationneeded that re-arms until the connection is back to stable.
 */
export class MockPeerConnection implements RtcPeerConnectionLike {
  readonly pcId: number;
  readonly ownerTag: string;
  readonly config: RtcConfigLike;

  localDescription: SessionDescriptionLike | null = null;
  remoteDescription: SessionDescriptionLike | null = null;
  signalingState: SignalingStateLike = 'stable';
  connectionState: ConnectionStateLike = 'new';

  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: IceCandidateInit | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: { track: MediaStreamTrackLike; streams: unknown[] }) => void) | null = null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null = null;

  addedCandidates: IceCandidateInit[] = [];
  restartCount = 0;
  offersCreated: string[] = [];

  readonly channels = new Map<number, MockDataChannel>();
  readonly senders: MockRtpSender[] = [];
  /** Tracks not yet delivered to the linked counterpart. */
  readonly pendingTracks: MediaStreamTrackLike[] = [];

  restartIce?: () => void;

  private readonly net: MockNetwork;
  private readonly clock: VirtualClock;
  private sdpCounter = 0;
  private candCounter = 0;
  private autoChannelId = 1000;
  private negotiationArmed = false;
  private negotiationPendingStable = false;
  private nextOfferIsRestart = false;
  private closed = false;

  constructor(net: MockNetwork, clock: VirtualClock, pcId: number, ownerTag: string, config: RtcConfigLike) {
    this.net = net;
    this.clock = clock;
    this.pcId = pcId;
    this.ownerTag = ownerTag;
    this.config = config;
    this.restartIce = () => {
      this.restartCount += 1;
      this.nextOfferIsRestart = true;
      this.triggerNegotiationNeeded();
    };
  }

  createOffer(options?: { iceRestart?: boolean }): Promise<SessionDescriptionLike> {
    this.sdpCounter += 1;
    const restart = options?.iceRestart === true || this.nextOfferIsRestart;
    const sdp = `offer:${this.pcId}:${this.sdpCounter}${restart ? ':restart' : ''}`;
    this.offersCreated.push(sdp);
    return Promise.resolve({ type: 'offer', sdp });
  }

  createAnswer(): Promise<SessionDescriptionLike> {
    if (this.signalingState !== 'have-remote-offer') {
      return Promise.reject(new Error(`InvalidStateError: createAnswer in ${this.signalingState}`));
    }
    this.sdpCounter += 1;
    return Promise.resolve({ type: 'answer', sdp: `answer:${this.pcId}:${this.sdpCounter}` });
  }

  async setLocalDescription(description?: SessionDescriptionLike): Promise<void> {
    this.assertNotClosed();
    let desc = description;
    if (desc === undefined) {
      if (this.signalingState === 'stable' || this.signalingState === 'have-local-offer') {
        desc = await this.createOffer();
      } else if (this.signalingState === 'have-remote-offer') {
        desc = await this.createAnswer();
      } else {
        throw new Error(`InvalidStateError: setLocalDescription() in ${this.signalingState}`);
      }
    }
    if (desc.type === 'offer') {
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') {
        throw new Error(`InvalidStateError: local offer in ${this.signalingState}`);
      }
      this.localDescription = desc;
      this.signalingState = 'have-local-offer';
      this.nextOfferIsRestart = false;
    } else if (desc.type === 'answer') {
      if (this.signalingState !== 'have-remote-offer') {
        throw new Error(`InvalidStateError: local answer in ${this.signalingState}`);
      }
      this.localDescription = desc;
      this.signalingState = 'stable';
      this.onBackToStable();
      this.net.noteStable(this);
    } else if (desc.type === 'rollback') {
      this.localDescription = null;
      this.signalingState = 'stable';
      this.onBackToStable();
    }
    this.scheduleIce();
  }

  setRemoteDescription(description: SessionDescriptionLike): Promise<void> {
    this.assertNotClosed();
    if (description.type === 'offer') {
      if (this.signalingState === 'have-local-offer') {
        // Implicit rollback (spec): the polite side of perfect negotiation
        // depends on this.
        this.localDescription = null;
        this.signalingState = 'stable';
      } else if (this.signalingState !== 'stable') {
        return Promise.reject(
          new Error(`InvalidStateError: remote offer in ${this.signalingState}`),
        );
      }
      this.remoteDescription = description;
      this.signalingState = 'have-remote-offer';
      this.net.noteHeard(this, pcIdFromSdp(description.sdp));
      return Promise.resolve();
    }
    if (description.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') {
        return Promise.reject(new Error(`InvalidStateError: answer in ${this.signalingState}`));
      }
      this.remoteDescription = description;
      this.signalingState = 'stable';
      this.net.noteHeard(this, pcIdFromSdp(description.sdp));
      this.onBackToStable();
      this.net.noteStable(this);
      return Promise.resolve();
    }
    // rollback
    this.remoteDescription = null;
    this.signalingState = 'stable';
    this.onBackToStable();
    return Promise.resolve();
  }

  addIceCandidate(candidate: IceCandidateInit): Promise<void> {
    if (this.remoteDescription === null) {
      return Promise.reject(new Error('InvalidStateError: no remote description'));
    }
    this.addedCandidates.push(candidate);
    return Promise.resolve();
  }

  addTrack(track: MediaStreamTrackLike, ..._streams: unknown[]): RtpSenderLike {
    this.assertNotClosed();
    const sender = new MockRtpSender(track);
    this.senders.push(sender);
    this.pendingTracks.push(track);
    this.triggerNegotiationNeeded();
    this.net.deliverPendingTracks(this);
    return sender;
  }

  removeTrack(sender: RtpSenderLike): void {
    const index = this.senders.indexOf(sender as MockRtpSender);
    if (index >= 0) this.senders.splice(index, 1);
    this.triggerNegotiationNeeded();
  }

  getSenders(): RtpSenderLike[] {
    return [...this.senders];
  }

  createDataChannel(label: string, init?: DataChannelInitLike): DataChannelLike {
    this.assertNotClosed();
    const id = init?.id ?? this.autoChannelId++;
    const dc = new MockDataChannel(this.clock, this.net.rng, label, id);
    this.channels.set(id, dc);
    this.triggerNegotiationNeeded();
    this.net.tryOpenChannels(this);
    return dc;
  }

  getStats(): Promise<unknown> {
    return Promise.resolve({ pcId: this.pcId, ownerTag: this.ownerTag });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.setConnectionState('closed');
    for (const dc of this.channels.values()) dc.close();
    this.net.noteClosed(this);
  }

  /** Harness hook: force a connection state and fire the handler. */
  forceConnectionState(state: ConnectionStateLike): void {
    this.setConnectionState(state);
  }

  /** Harness/network hook: set state + notify (no-op when unchanged/closed). */
  setConnectionState(state: ConnectionStateLike): void {
    if (this.connectionState === state) return;
    if (this.closed && state !== 'closed') return;
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  private assertNotClosed(): void {
    if (this.closed) throw new Error('InvalidStateError: peer connection is closed');
  }

  private scheduleIce(): void {
    this.candCounter += 1;
    const n = this.candCounter;
    this.clock.setTimeoutFn(() => {
      if (this.closed) return;
      this.onicecandidate?.({
        candidate: { candidate: `cand:${this.pcId}:${n}`, sdpMid: '0', sdpMLineIndex: 0 },
      });
      this.onicecandidate?.({ candidate: null });
    }, 1);
  }

  private triggerNegotiationNeeded(): void {
    if (this.negotiationArmed) return;
    this.negotiationArmed = true;
    this.clock.setTimeoutFn(() => {
      this.negotiationArmed = false;
      if (this.closed) return;
      if (this.signalingState !== 'stable') {
        // Re-fire on the next transition back to stable so negotiations do
        // not get stuck after glare.
        this.negotiationPendingStable = true;
        return;
      }
      this.onnegotiationneeded?.();
    }, 0);
  }

  private onBackToStable(): void {
    if (!this.negotiationPendingStable) return;
    this.negotiationPendingStable = false;
    this.triggerNegotiationNeeded();
  }
}

/** One simulated WebRTC world: pcs, links, channels, all on a VirtualClock. */
export class MockNetwork {
  readonly rng: () => number;
  /** Total peer connections created through rtcFactory. */
  pcCount = 0;

  private readonly clock: VirtualClock;
  private nextOwnerTag = 'anon';
  private nextPcId = 1;
  private readonly pcs = new Map<number, MockPeerConnection>();
  /** Directed "P heard Q" facts, keyed `${p}->${q}`. */
  private readonly heard = new Set<string>();
  /** Established links, keyed by sorted pcId pair `${a}~${b}`. */
  private readonly links = new Set<string>();
  private defaultFaults: ResolvedFaults = DEFAULT_FAULTS;
  private readonly pairFaults = new Map<string, ResolvedFaults>();

  constructor(clock: VirtualClock, rng?: () => number) {
    this.clock = clock;
    this.rng = rng ?? mulberry32(1);
  }

  readonly rtcFactory: RtcFactory = (config) => {
    const pc = new MockPeerConnection(this, this.clock, this.nextPcId++, this.nextOwnerTag, config);
    this.pcs.set(pc.pcId, pc);
    this.pcCount += 1;
    return pc;
  };

  /** Tag the owner of the NEXT pcs created by rtcFactory. */
  setNextOwner(tag: string): void {
    this.nextOwnerTag = tag;
  }

  setDefaultFaults(f: LinkFaults): void {
    this.defaultFaults = resolveFaults(f);
  }

  /** Fault override for traffic between pcs owned by these two tags. */
  setFaultsBetween(ownerA: string, ownerB: string, f: LinkFaults): void {
    const key = ownerA < ownerB ? `${ownerA}~${ownerB}` : `${ownerB}~${ownerA}`;
    this.pairFaults.set(key, resolveFaults(f));
  }

  /** Stand-alone pre-opened channel pair (no pcs involved). */
  createChannelPair(faults?: LinkFaults): [DataChannelLike, DataChannelLike] {
    const resolved = resolveFaults(faults);
    const a = new MockDataChannel(this.clock, this.rng, 'pair', 0);
    const b = new MockDataChannel(this.clock, this.rng, 'pair', 0);
    a.peer = b;
    b.peer = a;
    a.faults = resolved;
    b.faults = resolved;
    a.forceOpen();
    b.forceOpen();
    return [a, b];
  }

  // ---------- link bookkeeping (called by MockPeerConnection) ----------

  /** pc applied a remote description embedding `remotePcId`. */
  noteHeard(pc: MockPeerConnection, remotePcId: number | null): void {
    if (remotePcId === null) return;
    this.heard.add(`${pc.pcId}->${remotePcId}`);
  }

  /** pc transitioned back to stable — check whether its pair is negotiated. */
  noteStable(pc: MockPeerConnection): void {
    for (const key of this.heard) {
      const [pStr, qStr] = key.split('->') as [string, string];
      const p = Number(pStr);
      const q = Number(qStr);
      if (p !== pc.pcId && q !== pc.pcId) continue;
      if (!this.heard.has(`${q}->${p}`)) continue;
      const a = this.pcs.get(Math.min(p, q));
      const b = this.pcs.get(Math.max(p, q));
      if (a === undefined || b === undefined) continue;
      if (a.signalingState !== 'stable' || b.signalingState !== 'stable') continue;
      this.establishLink(a, b);
    }
  }

  noteClosed(pc: MockPeerConnection): void {
    const counterpart = this.linkedCounterpart(pc);
    if (counterpart !== undefined && counterpart.connectionState !== 'closed') {
      this.clock.setTimeoutFn(() => {
        if (counterpart.connectionState === 'closed') return;
        counterpart.setConnectionState('disconnected');
      }, 10);
    }
  }

  /** Deliver pending local tracks to the linked counterpart's ontrack. */
  deliverPendingTracks(pc: MockPeerConnection): void {
    const counterpart = this.linkedCounterpart(pc);
    if (counterpart === undefined) return;
    if (pc.connectionState !== 'connected') return;
    const tracks = pc.pendingTracks.splice(0, pc.pendingTracks.length);
    for (const track of tracks) {
      this.clock.setTimeoutFn(() => {
        counterpart.ontrack?.({ track, streams: [] });
      }, this.faultsFor(pc, counterpart).delayMs);
    }
  }

  /** Try to open matching negotiated channels for a pc's link (idempotent). */
  tryOpenChannels(pc: MockPeerConnection): void {
    const counterpart = this.linkedCounterpart(pc);
    if (counterpart === undefined || pc.connectionState !== 'connected') return;
    this.openMatchingChannels(pc, counterpart);
  }

  // ---------- internals ----------

  private linkKey(a: MockPeerConnection, b: MockPeerConnection): string {
    return `${Math.min(a.pcId, b.pcId)}~${Math.max(a.pcId, b.pcId)}`;
  }

  private linkedCounterpart(pc: MockPeerConnection): MockPeerConnection | undefined {
    for (const key of this.links) {
      const [aStr, bStr] = key.split('~') as [string, string];
      const a = Number(aStr);
      const b = Number(bStr);
      if (a === pc.pcId) return this.pcs.get(b);
      if (b === pc.pcId) return this.pcs.get(a);
    }
    return undefined;
  }

  private faultsFor(a: MockPeerConnection, b: MockPeerConnection): ResolvedFaults {
    const key =
      a.ownerTag < b.ownerTag ? `${a.ownerTag}~${b.ownerTag}` : `${b.ownerTag}~${a.ownerTag}`;
    return this.pairFaults.get(key) ?? this.defaultFaults;
  }

  private establishLink(a: MockPeerConnection, b: MockPeerConnection): void {
    const key = this.linkKey(a, b);
    if (this.links.has(key)) {
      // Renegotiation over an existing link: no state churn, but any tracks
      // added since the last exchange flow now.
      this.deliverPendingTracks(a);
      this.deliverPendingTracks(b);
      return;
    }
    this.links.add(key);
    this.clock.setTimeoutFn(() => {
      a.setConnectionState('connecting');
      b.setConnectionState('connecting');
    }, 1);
    this.clock.setTimeoutFn(() => {
      if (a.connectionState === 'closed' || b.connectionState === 'closed') return;
      a.setConnectionState('connected');
      b.setConnectionState('connected');
      this.openMatchingChannels(a, b);
      this.deliverPendingTracks(a);
      this.deliverPendingTracks(b);
    }, 11);
  }

  private openMatchingChannels(a: MockPeerConnection, b: MockPeerConnection): void {
    const faults = this.faultsFor(a, b);
    for (const [id, dcA] of a.channels) {
      const dcB = b.channels.get(id);
      if (dcB === undefined) continue;
      if (dcA.readyState === 'open' && dcB.readyState === 'open') continue;
      if (dcA.readyState === 'closed' || dcB.readyState === 'closed') continue;
      dcA.peer = dcB;
      dcB.peer = dcA;
      dcA.faults = faults;
      dcB.faults = faults;
      dcA.forceOpen();
      dcB.forceOpen();
    }
  }
}

/** In-memory signaling hub emulating the room WS relay. */
export class SignalRouter {
  /** One-way signaling delivery delay in ms. */
  delayMs = 5;

  private readonly clock: VirtualClock;
  private readonly roomId: RoomId;
  private readonly handlers = new Map<UserId, (ev: InboundSignal) => void>();
  private readonly partitions = new Set<string>();
  private seq = 0;
  /** Every outbound client event that crossed the hub (for assertions). */
  readonly sentEvents: OutboundSignal[] = [];

  constructor(clock: VirtualClock, roomId: RoomId) {
    this.clock = clock;
    this.roomId = roomId;
  }

  /** Register a user's inbound handler; returns their outbound SignalSend. */
  attach(userId: UserId, onSignal: (ev: InboundSignal) => void): (ev: OutboundSignal) => void {
    this.handlers.set(userId, onSignal);
    return (ev) => {
      if (ev.seq !== 0) return;
      this.sentEvents.push(ev);
      const target = ev.payload.targetUserId;
      if (this.isPartitioned(userId, target)) return;
      const handler = this.handlers.get(target);
      if (handler === undefined) return;
      this.seq += 1;
      const seq = this.seq;
      const serverEvent = {
        type: ev.type,
        roomId: this.roomId,
        seq,
        ts: Math.floor(this.clock.now()),
        payload: { ...ev.payload, fromUserId: userId },
      } as InboundSignal;
      this.clock.setTimeoutFn(() => {
        handler(serverEvent);
      }, this.delayMs);
    };
  }

  /** Drop all signaling between a and b (both directions) until healed. */
  partition(a: UserId, b: UserId): void {
    this.partitions.add(this.pairKey(a, b));
  }

  heal(a: UserId, b: UserId): void {
    this.partitions.delete(this.pairKey(a, b));
  }

  private pairKey(a: UserId, b: UserId): string {
    return a < b ? `${a}~${b}` : `${b}~${a}`;
  }

  private isPartitioned(a: UserId, b: UserId): boolean {
    return this.partitions.has(this.pairKey(a, b));
  }
}
