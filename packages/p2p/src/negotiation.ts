/**
 * Perfect negotiation (RFC 8829 glare-resolution pattern) for one peer pair,
 * adapted to injected RTC primitives: signaling rides the room websocket via
 * the injected `SignalSend`, and every failure is reported through `onError`
 * instead of thrown — a broken pair must never take the mesh down with it.
 */

import type { IceCandidateInit, RoomId, UserId } from '@gather/contracts';
import type { InboundSignal, NowFn, RtcPeerConnectionLike, SignalSend } from './types';

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
  /** Non-fatal negotiation errors surface here (never thrown). */
  onError?: (context: string, err: unknown) => void;
}

/**
 * Drives offer/answer/ICE exchange for a single peer connection using the
 * perfect-negotiation pattern: the polite peer rolls back on glare, the
 * impolite peer ignores colliding offers, and ICE candidates arriving before
 * a remote description are queued and flushed after it lands.
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
  private readonly onError: (context: string, err: unknown) => void;

  private makingOffer = false;
  private ignoreOffer = false;
  private iceQueue: IceCandidateInit[] = [];

  constructor(opts: PerfectNegotiatorOptions) {
    this.polite = opts.localUserId < opts.remoteUserId;
    this.pc = opts.pc;
    this.roomId = opts.roomId;
    this.remoteUserId = opts.remoteUserId;
    this.connectionId = opts.connectionId;
    this.send = opts.send;
    this.now = opts.now;
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
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
  }

  private async onNegotiationNeeded(): Promise<void> {
    try {
      this.makingOffer = true;
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
