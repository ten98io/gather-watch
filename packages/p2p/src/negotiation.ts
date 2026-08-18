/**
 * Perfect negotiation (RFC 8829 glare-resolution pattern) for one peer pair,
 * adapted to injected RTC primitives: signaling rides the room websocket via
 * the injected `SignalSend`, and every failure is reported through `onError`
 * instead of thrown — a broken pair must never take the mesh down with it.
 */

import type { IceCandidateInit, RoomId, UserId } from '@gather/contracts';
import type {
  ClearTimeoutFn,
  InboundSignal,
  NowFn,
  RtcPeerConnectionLike,
  SetTimeoutFn,
  SignalSend,
  TimeoutHandle,
} from './types';

/** Options for {@link PerfectNegotiator}. */
export interface PerfectNegotiatorOptions {
  pc: RtcPeerConnectionLike;
  roomId: RoomId;
  localUserId: UserId;
  remoteUserId: UserId;
  /** Stable per pair; every signal this negotiator sends carries it. */
  connectionId: string;
  send: SignalSend;
  now: NowFn;
  /** Required to re-send an unanswered offer; without them the retry is off. */
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  /** Re-send an offer that has gone unanswered for this long. Default 3000;
   *  0 disables the retry. */
  offerRetryMs?: number;
  /** How many times ONE unanswered offer is re-sent before giving up. */
  offerRetryLimit?: number;
  /** Non-fatal negotiation errors surface here (never thrown). */
  onError?: (context: string, err: unknown) => void;
}

/** Default gap before an unanswered offer is re-sent. Comfortably longer than
 *  a signalling round trip, so a healthy pair never re-offers at all. */
const DEFAULT_OFFER_RETRY_MS = 3000;

/** Default cap on re-sends of one offer: enough to ride out a websocket
 *  reconnect, few enough that a genuinely unreachable peer stops trying. */
const DEFAULT_OFFER_RETRY_LIMIT = 4;

/**
 * Drives offer/answer/ICE exchange for a single peer connection using the
 * perfect-negotiation pattern: the polite peer rolls back on glare, the
 * impolite peer ignores colliding offers, and ICE candidates arriving before
 * a remote description are queued and flushed after it lands.
 *
 * Offers are also RE-SENT while they go unanswered (bounded). Nothing else in
 * the stack retries: `negotiationneeded` fires once per change, so a single
 * lost or ignored offer used to leave the pair stuck in have-local-offer for
 * the life of the connection.
 */
export class PerfectNegotiator {
  /** Polite peer = lexicographically LOWER userId (localUserId < remoteUserId). */
  readonly polite: boolean;

  private readonly pc: RtcPeerConnectionLike;
  private readonly roomId: RoomId;
  private readonly remoteUserId: UserId;
  private readonly connectionId: string;
  private readonly send: SignalSend;
  private readonly now: NowFn;
  private readonly setTimeoutFn: SetTimeoutFn | undefined;
  private readonly clearTimeoutFn: ClearTimeoutFn | undefined;
  private readonly offerRetryMs: number;
  private readonly offerRetryLimit: number;
  private readonly onError: (context: string, err: unknown) => void;

  private makingOffer = false;
  private ignoreOffer = false;
  private iceQueue: IceCandidateInit[] = [];
  private retryTimer: TimeoutHandle | null = null;
  private retriesLeft: number;

  constructor(opts: PerfectNegotiatorOptions) {
    this.polite = opts.localUserId < opts.remoteUserId;
    this.pc = opts.pc;
    this.roomId = opts.roomId;
    this.remoteUserId = opts.remoteUserId;
    this.connectionId = opts.connectionId;
    this.send = opts.send;
    this.now = opts.now;
    this.setTimeoutFn = opts.setTimeoutFn;
    this.clearTimeoutFn = opts.clearTimeoutFn;
    this.offerRetryMs = opts.offerRetryMs ?? DEFAULT_OFFER_RETRY_MS;
    this.offerRetryLimit = opts.offerRetryLimit ?? DEFAULT_OFFER_RETRY_LIMIT;
    this.retriesLeft = this.offerRetryLimit;
    this.onError = opts.onError ?? (() => {});

    // Only the two handlers negotiation owns; the mesh keeps ontrack,
    // onconnectionstatechange and ondatachannel for itself.
    this.pc.onnegotiationneeded = () => {
      void this.onNegotiationNeeded();
    };
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate === null) return;
      this.send({
        type: 'webrtc.ice',
        roomId: this.roomId,
        seq: 0,
        ts: Math.floor(this.now()),
        payload: {
          targetUserId: this.remoteUserId,
          connectionId: this.connectionId,
          candidate: ev.candidate,
        },
      });
    };
  }

  /** Route a server-relayed webrtc.offer/answer/ice event for this pair. */
  async handleSignal(ev: InboundSignal): Promise<void> {
    // Defensive: the mesh routes by pair, but a misrouted or spoofed signal
    // must not touch this connection.
    if (ev.payload.connectionId !== this.connectionId) return;
    if (ev.payload.fromUserId !== this.remoteUserId) return;
    switch (ev.type) {
      case 'webrtc.offer':
        await this.handleOffer(ev.payload.sdp);
        return;
      case 'webrtc.answer':
        await this.handleAnswer(ev.payload.sdp);
        return;
      case 'webrtc.ice':
        await this.handleIce(ev.payload.candidate);
        return;
    }
  }

  /** Trigger an ICE restart (pc.restartIce() when present, else createOffer({iceRestart:true})). */
  restartIce(): void {
    if (this.pc.restartIce) {
      this.pc.restartIce();
      return;
    }
    void this.restartIceFallback();
  }

  /** Detach pc handlers this class installed. */
  dispose(): void {
    this.clearOfferRetry();
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
  }

  private async onNegotiationNeeded(): Promise<void> {
    try {
      this.makingOffer = true;
      // A fresh negotiation gets a fresh retry budget.
      this.retriesLeft = this.offerRetryLimit;
      // Parameterless form: the stack creates the implicit offer itself.
      await this.pc.setLocalDescription();
      this.sendOffer();
    } catch (err) {
      this.onError('negotiationneeded', err);
    } finally {
      this.makingOffer = false;
    }
  }

  private async handleOffer(sdp: string): Promise<void> {
    try {
      const offerCollision = this.makingOffer || this.pc.signalingState !== 'stable';
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;
      // On collision the polite side lands here and relies on implicit
      // rollback inside setRemoteDescription.
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      // Any local offer we were waiting on is gone (rolled back, or there was
      // none): answering this one is now the whole negotiation.
      this.clearOfferRetry();
      await this.flushIceQueue();
      await this.pc.setLocalDescription();
      this.sendAnswer();
      this.ignoreOffer = false;
    } catch (err) {
      this.onError('offer', err);
    }
  }

  private async handleAnswer(sdp: string): Promise<void> {
    // Stale or glare-loser answers arrive when we have no outstanding local
    // offer; applying them would corrupt the state machine, so drop them.
    if (this.pc.signalingState !== 'have-local-offer') return;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      this.clearOfferRetry();
      await this.flushIceQueue();
    } catch (err) {
      this.onError('answer', err);
    }
  }

  private async handleIce(candidate: IceCandidateInit): Promise<void> {
    if (this.pc.remoteDescription === null) {
      // Trickle ICE can outrun the offer/answer exchange; hold candidates
      // until a remote description exists.
      this.iceQueue.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // While ignoring a colliding offer, its candidates fail by design.
      if (!this.ignoreOffer) this.onError('ice', err);
    }
  }

  private async flushIceQueue(): Promise<void> {
    const queued = this.iceQueue;
    this.iceQueue = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        if (!this.ignoreOffer) this.onError('ice', err);
      }
    }
  }

  private async restartIceFallback(): Promise<void> {
    // Reentrancy guard: an in-flight offer already covers the restart.
    if (this.makingOffer) return;
    try {
      this.makingOffer = true;
      this.retriesLeft = this.offerRetryLimit;
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.sendOffer();
    } catch (err) {
      this.onError('restartIce', err);
    } finally {
      this.makingOffer = false;
    }
  }

  private sendOffer(): void {
    this.send({
      type: 'webrtc.offer',
      roomId: this.roomId,
      seq: 0,
      ts: Math.floor(this.now()),
      payload: {
        targetUserId: this.remoteUserId,
        connectionId: this.connectionId,
        sdp: this.pc.localDescription!.sdp ?? '',
      },
    });
    this.armOfferRetry();
  }

  /** Start (or restart) the clock on the offer just sent. */
  private armOfferRetry(): void {
    this.clearOfferRetry();
    if (this.setTimeoutFn === undefined || this.clearTimeoutFn === undefined) return;
    if (this.offerRetryMs <= 0 || this.retriesLeft <= 0) return;
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      this.resendOffer();
    }, this.offerRetryMs);
  }

  /** Re-send the offer still sitting in localDescription. Re-sending the SAME
   *  description is deliberate: it needs no new ICE gathering, and a remote
   *  that already applied it simply answers again. */
  private resendOffer(): void {
    // Answered, rolled back, or closed since it went out: nothing is pending.
    if (this.pc.signalingState !== 'have-local-offer') return;
    if (this.pc.localDescription === null) return;
    if (this.retriesLeft <= 0) return;
    this.retriesLeft -= 1;
    this.sendOffer();
  }

  private clearOfferRetry(): void {
    if (this.retryTimer === null) return;
    this.clearTimeoutFn?.(this.retryTimer);
    this.retryTimer = null;
  }

  private sendAnswer(): void {
    this.send({
      type: 'webrtc.answer',
      roomId: this.roomId,
      seq: 0,
      ts: Math.floor(this.now()),
      payload: {
        targetUserId: this.remoteUserId,
        connectionId: this.connectionId,
        sdp: this.pc.localDescription!.sdp ?? '',
      },
    });
  }
}
