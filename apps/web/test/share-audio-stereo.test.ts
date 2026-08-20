/**
 * THE SHARE'S SOUNDTRACK CROSSES AS STEREO MUSIC; THE MIC CROSSES UNTOUCHED.
 *
 * The field report: a web-hosted share's sound was "glitchy" and thin under
 * cross-talk. It was crossing the mesh as default Opus — the VOICE tuning,
 * one channel at ~32 kbps. The extension fixed exactly this by munging its
 * SDP (offscreen.ts preferStereoOpus), but its offscreen peer connection
 * carries ONLY share audio, so it may tune every audio m-section. The web
 * CallMesh carries the MICROPHONE on the same SDP, and the mic must stay
 * voice-tuned — so the munge may touch only the m-sections that carry share
 * audio, found by `a=msid` against the mesh's role stream ids (ours local,
 * theirs announced), with the matched `a=mid` remembered per connection so
 * the msid-less recvonly answer keeps what its offer established.
 *
 * The load-bearing assertion in this file is byte-identity of the mic's
 * m-section. Everything else is the extension's proven rules, re-pinned at
 * the web's boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceEntry, RoomId, TurnCredentialsResponse, UserId } from '@gather/contracts';
import { CallMesh, SHARE_AUDIO_MAX_BITRATE, tuneShareAudioSdp } from '@/lib/call-mesh';
import type { RoomConnection } from '@/lib/room-connection';

/* The TURN fetch, per test. Hoisted so the module mock below can reach it. */
const turnStub = vi.hoisted(() => ({
  fetch: (): Promise<TurnCredentialsResponse> => Promise.reject(new Error('offline')),
}));

vi.mock('@/lib/api', () => ({
  api: { rtc: { turnCredentials: () => turnStub.fetch() } },
}));

/** Drain the microtask queue — the negotiator's handlers are await chains. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const CREDENTIALS: TurnCredentialsResponse = {
  iceServers: [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }],
  ttlSeconds: 0,
  fairUseRemainingGb: null,
};

const OPUS_TUNING = `stereo=1;sprop-stereo=1;maxaveragebitrate=${String(SHARE_AUDIO_MAX_BITRATE)}`;

/* ── fakes (the call-mesh.test.ts idiom, with SDP made controllable) ───────── */

class FakeTrack {
  enabled = true;
  constructor(
    readonly id: string,
    readonly kind: 'audio' | 'video',
  ) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  stop(): void {}
}

const track = (id: string, kind: 'audio' | 'video'): MediaStreamTrack =>
  new FakeTrack(id, kind) as unknown as MediaStreamTrack;

class FakeDataChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  constructor(readonly label: string) {}
  send(): void {}
  close(): void {}
}

interface FakeSender {
  track: unknown;
  getParameters(): { encodings: Array<{ maxBitrate?: number }> };
  setParameters(): Promise<void>;
  replaceTrack(next: unknown): Promise<void>;
}

/** A peer connection whose descriptions the TEST writes: `nextLocalSdp` is
 *  what the negotiator's implicit setLocalDescription() "creates", and every
 *  remote description applied lands in `remoteSdps` — the observation point
 *  for what the inbound tuning actually handed the browser. */
class FakePc {
  static instances: FakePc[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  signalingState = 'stable';
  connectionState = 'new';
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((ev: { track: unknown; streams: unknown[] }) => void) | null = null;
  ondatachannel: ((ev: { channel: unknown }) => void) | null = null;
  nextLocalSdp = '';
  readonly remoteSdps: string[] = [];
  readonly addedCandidates: unknown[] = [];
  private readonly senders: FakeSender[] = [];

  constructor(readonly config?: { iceServers?: unknown[] }) {
    FakePc.instances.push(this);
  }
  static reset(): void {
    FakePc.instances = [];
  }
  setConfiguration(): void {}
  restartIce(): void {}
  createOffer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'offer', sdp: this.nextLocalSdp });
  }
  createAnswer(): Promise<{ type: string; sdp: string }> {
    return Promise.resolve({ type: 'answer', sdp: this.nextLocalSdp });
  }
  /** The parameterless form the negotiator uses, with the two signaling-state
   *  transitions it depends on (offer → have-local-offer, answer → stable). */
  setLocalDescription(desc?: { type: string; sdp: string }): Promise<void> {
    const answering = this.signalingState === 'have-remote-offer';
    this.localDescription = desc ?? {
      type: answering ? 'answer' : 'offer',
      sdp: this.nextLocalSdp,
    };
    this.signalingState = answering ? 'stable' : 'have-local-offer';
    return Promise.resolve();
  }
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = desc;
    this.remoteSdps.push(desc.sdp);
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    return Promise.resolve();
  }
  addIceCandidate(candidate: unknown): Promise<void> {
    this.addedCandidates.push(candidate);
    return Promise.resolve();
  }
  addTrack(t: unknown): FakeSender {
    const sender: FakeSender = {
      track: t,
      getParameters: () => ({ encodings: [{}] }),
      setParameters: () => Promise.resolve(),
      replaceTrack: (next: unknown) => {
        sender.track = next;
        return Promise.resolve();
      },
    };
    this.senders.push(sender);
    return sender;
  }
  removeTrack(): void {}
  getSenders(): FakeSender[] {
    return this.senders;
  }
  createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }
  getStats(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  close(): void {}
}

/** The mesh reads nothing off a MediaStream but its id. Deterministic ids so
 *  the fabricated SDP can name the stream each role was minted. */
let streamCount = 0;
class FakeMediaStream {
  readonly id = `s-${(streamCount += 1)}`;
}

const presenceEntry = (userId: string, state: PresenceEntry['state']): PresenceEntry => ({
  userId: userId as UserId,
  state,
  micOn: true,
  camOn: false,
  sharing: false,
  lastSeenTs: 0,
});

/** One signalling frame the mesh handed to the room socket. */
interface SentFrame {
  type: string;
  payload: {
    targetUserId?: UserId;
    connectionId?: string;
    sdp?: string;
    candidate?: unknown;
  };
}

interface FakeConnection {
  connection: RoomConnection;
  sent: SentFrame[];
  deliver(type: string, payload: Record<string, unknown>): void;
}

function fakeConnection(initial: Record<string, PresenceEntry>): FakeConnection {
  const listeners = new Set<(s: unknown, prev: unknown) => void>();
  const state = { presence: initial };
  const sent: SentFrame[] = [];
  const inbound = new Map<string, Set<(ev: unknown) => void>>();
  const connection = {
    roomId: 'room_test' as RoomId,
    rawSocket: {
      send: (type: string, payload: SentFrame['payload']) => {
        sent.push({ type, payload });
      },
    },
    useRoomState: {
      getState: () => state,
      subscribe: (fn: (s: unknown, prev: unknown) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    on: (type: string, fn: (ev: unknown) => void) => {
      const set = inbound.get(type) ?? new Set<(ev: unknown) => void>();
      set.add(fn);
      inbound.set(type, set);
      return () => set.delete(fn);
    },
  } as unknown as RoomConnection;
  return {
    connection,
    sent,
    deliver(type, payload) {
      for (const fn of [...(inbound.get(type) ?? [])]) {
        fn({ type, roomId: 'room_test' as RoomId, seq: 1, ts: 0, payload });
      }
    },
  };
}

/* ── SDP fixtures and dissection ───────────────────────────────────────────── */

const ME = 'user_me' as UserId;
const PEER = 'user_peer' as UserId;

/** The person-level pair id both sides derive ('user_me' sorts first). */
const PAIR_ID = 'mesh:room_test:user_me~user_peer';

/**
 * A realistic multi-section browser offer: the mic's voice-tuned m-section,
 * a camera, the share's soundtrack on its OWN msid, the share's picture, and
 * the DataChannel fabric — the exact shape whose blanket tuning would wreck
 * the microphone.
 */
function multiSectionSdp(opts: {
  micStreamId: string;
  shareStreamId: string;
  direction?: string;
}): string {
  const direction = opts.direction ?? 'a=sendrecv';
  return [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1 2 3 4',
    'a=msid-semantic: WMS',
    // the microphone: voice-tuned Opus, and it has to STAY voice-tuned
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    direction,
    `a=msid:${opts.micStreamId} mic-track-1`,
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:63 red/48000/2',
    'a=fmtp:63 111/111',
    'a=rtpmap:9 G722/8000',
    'a=rtpmap:0 PCMU/8000',
    // the camera
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    direction,
    'a=msid:cam-stream-1 cam-track-1',
    'a=rtpmap:96 VP8/90000',
    'a=fmtp:96 x-google-max-bitrate=2000',
    // the share's soundtrack — the ONE audio section the munge may touch
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'c=IN IP4 0.0.0.0',
    'a=mid:2',
    direction,
    `a=msid:${opts.shareStreamId} share-audio-track-1`,
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:63 red/48000/2',
    'a=fmtp:63 111/111',
    // the share's picture
    'm=video 9 UDP/TLS/RTP/SAVPF 98',
    'c=IN IP4 0.0.0.0',
    'a=mid:3',
    direction,
    `a=msid:${opts.shareStreamId} share-track-1`,
    'a=rtpmap:98 VP9/90000',
    // the DataChannel fabric
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:4',
    'a=sctp-port:5000',
    '',
  ].join('\r\n');
}

/** An answer whose share-audio section is RECVONLY and carries NO msid — the
 *  shape a real answer takes, and the reason mids are remembered at all. */
function msidlessAnswerSdp(): string {
  return [
    'v=0',
    'o=- 9876543210 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1 2 3 4',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendrecv',
    'a=msid:answerer-mic-stream answerer-mic-track',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=recvonly',
    'a=rtpmap:96 VP8/90000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:2',
    'a=recvonly',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 98',
    'c=IN IP4 0.0.0.0',
    'a=mid:3',
    'a=recvonly',
    'a=rtpmap:98 VP9/90000',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:4',
    'a=sctp-port:5000',
    '',
  ].join('\r\n');
}

/** Split an SDP into its m-sections (the session preamble is dropped). */
function sections(sdp: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null;
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('m=')) {
      if (current !== null) out.push(current.join('\r\n'));
      current = [];
    }
    current?.push(line);
  }
  if (current !== null) out.push(current.join('\r\n'));
  return out;
}

/** The whole m-section carrying `a=mid:<mid>`, byte for byte. */
function sectionWithMid(sdp: string, mid: string): string {
  return sections(sdp).find((s) => s.split('\r\n').includes(`a=mid:${mid}`)) ?? '';
}

/** The stream id the mesh announced for one of OUR roles (read off the role
 *  frame it sent, rather than assuming mint order). */
function announcedId(conn: FakeConnection, role: string): string {
  const prefix = `mesh:room_test:role:${role}:`;
  const frame = conn.sent.find((f) => f.payload.connectionId?.startsWith(prefix) === true);
  return frame?.payload.connectionId?.slice(prefix.length) ?? '';
}

/** The newest sent frame of a type that actually carries a description. */
function lastDescription(conn: FakeConnection, type: string): SentFrame | undefined {
  return conn.sent
    .filter((f) => f.type === type && f.payload.sdp !== undefined && f.payload.sdp.includes('m='))
    .at(-1);
}

/* ── suite ─────────────────────────────────────────────────────────────────── */

describe('CallMesh share-audio stereo tuning', () => {
  const created: CallMesh[] = [];

  beforeEach(() => {
    FakePc.reset();
    streamCount = 0;
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePc;
    (globalThis as { MediaStream?: unknown }).MediaStream = FakeMediaStream;
    turnStub.fetch = () => Promise.resolve(CREDENTIALS);
  });

  afterEach(() => {
    for (const mesh of created.splice(0)) mesh.close();
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    delete (globalThis as { MediaStream?: unknown }).MediaStream;
  });

  const startedMesh = async (): Promise<{ mesh: CallMesh; conn: FakeConnection; pc: FakePc }> => {
    const conn = fakeConnection({ [PEER]: presenceEntry(PEER, 'in-call') });
    const mesh = new CallMesh(conn.connection, ME);
    created.push(mesh);
    mesh.start();
    await settle();
    const pc = FakePc.instances[0];
    if (pc === undefined) throw new Error('no peer connection was built');
    return { mesh, conn, pc };
  };

  /** A HOST: mic and share-audio published, so both role streams are minted
   *  and announced, and the next offer this pc "creates" is the fixture. */
  const hostWithOffer = async (): Promise<{
    conn: FakeConnection;
    pc: FakePc;
    sdp: string;
    pairId: string;
  }> => {
    const { mesh, conn, pc } = await startedMesh();
    mesh.setLocalTrack('mic', track('mic-local', 'audio'));
    mesh.setLocalTrack('share-audio', track('tab-audio-local', 'audio'));
    const sdp = multiSectionSdp({
      micStreamId: announcedId(conn, 'mic'),
      shareStreamId: announcedId(conn, 'share-audio'),
    });
    pc.nextLocalSdp = sdp;
    pc.onnegotiationneeded?.();
    await settle();
    const offer = lastDescription(conn, 'webrtc.offer');
    if (offer === undefined) throw new Error('no offer was sent');
    return { conn, pc, sdp, pairId: offer.payload.connectionId ?? '' };
  };

  it('tunes the share-audio section of an outbound offer, matched by our stream id', async () => {
    const { conn, sdp } = await hostWithOffer();
    const sent = lastDescription(conn, 'webrtc.offer')?.payload.sdp ?? '';

    const shareSection = sectionWithMid(sent, '2');
    expect(shareSection).toContain(`a=fmtp:111 minptime=10;useinbandfec=1;${OPUS_TUNING}`);
    // The tuned section's OTHER codec (red) keeps its fmtp untouched.
    expect(shareSection).toContain('a=fmtp:63 111/111');
    // Something was sent at all, and it was the fixture, tuned — not 'sdp'.
    expect(sent).not.toBe(sdp);
  });

  it('carries the MIC m-section byte-identical — the whole point of not blanket-tuning', async () => {
    const { conn, sdp } = await hostWithOffer();
    const sent = lastDescription(conn, 'webrtc.offer')?.payload.sdp ?? '';

    // Load-bearing: the mic keeps its voice tuning to the byte. A blanket
    // munge (the extension's rule, correct on ITS pc) turns this red.
    expect(sectionWithMid(sent, '0')).toBe(sectionWithMid(sdp, '0'));
    // And the mic's fmtp still says exactly what it said.
    expect(sectionWithMid(sent, '0')).toContain('a=fmtp:111 minptime=10;useinbandfec=1\r\n');
    expect(sectionWithMid(sent, '0')).not.toContain('stereo=1');
  });

  it('carries video and data sections byte-identical', async () => {
    const { conn, sdp } = await hostWithOffer();
    const sent = lastDescription(conn, 'webrtc.offer')?.payload.sdp ?? '';

    for (const mid of ['1', '3', '4']) {
      expect(sectionWithMid(sent, mid)).toBe(sectionWithMid(sdp, mid));
    }
    // The session preamble too: nothing above the first m= is the munge's.
    expect(sent.split('m=')[0]).toBe(sdp.split('m=')[0]);
  });

  it('tunes an inbound answer whose share-audio section has NO msid, via the remembered mid', async () => {
    const { conn, pc, pairId } = await hostWithOffer();
    const answer = msidlessAnswerSdp();

    conn.deliver('webrtc.answer', {
      fromUserId: PEER,
      targetUserId: ME,
      connectionId: pairId,
      sdp: answer,
    });
    await settle();

    const applied = pc.remoteSdps.at(-1) ?? '';
    // The answer is the description WE apply, and the one that tells our own
    // encoder to send stereo — skipping it would leave the share in mono
    // however the offer read. mid 2 is share audio because our offer said so.
    expect(sectionWithMid(applied, '2')).toContain(OPUS_TUNING);
    // The answerer's mic section carries an msid nobody announced: untouched.
    expect(sectionWithMid(applied, '0')).toBe(sectionWithMid(answer, '0'));
  });

  it('tunes a remote host’s share on inbound offers and on OUR msid-less answer', async () => {
    const { conn, pc } = await startedMesh();
    // The host announces which stream id carries their share's soundtrack.
    conn.deliver('webrtc.offer', {
      fromUserId: PEER,
      targetUserId: ME,
      connectionId: 'mesh:room_test:role:share-audio:peer-tab-stream',
      sdp: '',
    });
    const offer = multiSectionSdp({
      micStreamId: 'peer-mic-stream',
      shareStreamId: 'peer-tab-stream',
    });
    const ourAnswer = msidlessAnswerSdp();
    pc.nextLocalSdp = ourAnswer;

    conn.deliver('webrtc.offer', {
      fromUserId: PEER,
      targetUserId: ME,
      connectionId: PAIR_ID,
      sdp: offer,
    });
    await settle();

    // Inbound: their offer reached our pc with the share section tuned (this
    // is what configures OUR decoder side and states what we can receive)…
    const applied = pc.remoteSdps.at(-1) ?? '';
    expect(sectionWithMid(applied, '2')).toContain(OPUS_TUNING);
    expect(sectionWithMid(applied, '0')).toBe(sectionWithMid(offer, '0'));

    // …and outbound: OUR answer — recvonly, no msid to match — was tuned via
    // the mid their offer established. Opus stereo=1 in a description means
    // "I want to RECEIVE stereo": this answer is what upgrades THEIR encoder.
    const sent = lastDescription(conn, 'webrtc.answer')?.payload.sdp ?? '';
    expect(sectionWithMid(sent, '2')).toContain(OPUS_TUNING);
    expect(sectionWithMid(sent, '0')).toBe(sectionWithMid(ourAnswer, '0'));
  });

  it('passes ICE events through untouched, both ways', async () => {
    const { conn, pc, pairId } = await hostWithOffer();
    const candidate = {
      candidate: 'candidate:1 1 udp 2113937151 192.0.2.1 56789 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };

    // Outbound: the frame carries the very same candidate object, and no sdp.
    pc.onicecandidate?.({ candidate });
    const iceFrame = conn.sent.filter((f) => f.type === 'webrtc.ice').at(-1);
    expect(iceFrame?.payload.candidate).toBe(candidate);
    expect(iceFrame?.payload.sdp).toBeUndefined();

    // Inbound: the same object reaches addIceCandidate.
    pc.remoteDescription = { type: 'answer', sdp: '' };
    conn.deliver('webrtc.ice', {
      fromUserId: PEER,
      targetUserId: ME,
      connectionId: pairId,
      candidate,
    });
    await settle();
    expect(pc.addedCandidates.at(-1)).toBe(candidate);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   The munge itself, rule by rule (the extension's, re-proven at this boundary)
   ──────────────────────────────────────────────────────────────────────────── */

describe('tuneShareAudioSdp', () => {
  const SHARE_IDS = new Set(['share-stream-1']);

  const shareSection = (fmtpLines: readonly string[]): string =>
    [
      'v=0',
      'o=- 1 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
      'a=mid:0',
      'a=msid:share-stream-1 t-1',
      'a=rtpmap:111 opus/48000/2',
      'a=rtpmap:63 red/48000/2',
      ...fmtpLines,
      '',
    ].join('\r\n');

  it('adds the fmtp line Opus was missing — no fmtp at all IS the mono default', () => {
    const out = tuneShareAudioSdp(shareSection(['a=fmtp:63 111/111']), SHARE_IDS, new Set());
    expect(out).toContain(`a=fmtp:111 ${OPUS_TUNING}`);
  });

  it('keeps what a matched section already stated, replacing only its own params', () => {
    const out = tuneShareAudioSdp(
      shareSection(['a=fmtp:111 stereo=0;maxaveragebitrate=24000;useinbandfec=1']),
      SHARE_IDS,
      new Set(),
    );
    expect(out).toContain(`a=fmtp:111 useinbandfec=1;${OPUS_TUNING}`);
    expect(out).not.toContain('stereo=0');
    expect(out).not.toContain('24000');
  });

  it('leaves non-Opus codecs alone even inside a tuned section', () => {
    const out = tuneShareAudioSdp(shareSection(['a=fmtp:63 111/111']), SHARE_IDS, new Set());
    expect(out).toContain('a=fmtp:63 111/111');
  });

  it('touches nothing whose msid and mid both say otherwise', () => {
    const sdp = multiSectionSdp({ micStreamId: 'mic-stream-1', shareStreamId: 'nobody' });
    // No known share stream, nothing remembered: the SAME string comes back —
    // not an equal one — so the no-share case cannot even re-join line ends.
    expect(tuneShareAudioSdp(sdp, new Set(), new Set())).toBe(sdp);
    expect(tuneShareAudioSdp(sdp, new Set(['absent-id']), new Set())).toBe(sdp);
  });

  it('remembers the matched mid, and answers a later msid-less description from it', () => {
    const mids = new Set<string>();
    const offer = multiSectionSdp({ micStreamId: 'mic-stream-1', shareStreamId: 'share-stream-1' });
    tuneShareAudioSdp(offer, SHARE_IDS, mids);
    expect(mids).toEqual(new Set(['2']));

    // The answer names no stream at all; the mid is the only thread back.
    const answer = msidlessAnswerSdp();
    const out = tuneShareAudioSdp(answer, SHARE_IDS, mids);
    expect(sectionWithMid(out, '2')).toContain(OPUS_TUNING);
    expect(sectionWithMid(out, '0')).toBe(sectionWithMid(answer, '0'));
  });
});
