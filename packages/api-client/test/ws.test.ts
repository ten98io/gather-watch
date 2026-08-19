import { describe, expect, it } from 'vitest';
import type { RoomId, WsEnvelope } from '@gather/contracts';
import { ApiError, RoomSocket } from '../src';
import type { RoomSocketOptions, WebSocketCtor } from '../src';
import { ManualTimers, MockWebSocket, pongEvt, rid, tick, typingEvt } from './helpers';

const setup = (over?: {
  rng?: () => number;
  replay?: (roomId: RoomId, since: number) => Promise<WsEnvelope[]>;
  opts?: Partial<RoomSocketOptions>;
}) => {
  MockWebSocket.reset();
  const timers = new ManualTimers();
  const replayCalls: number[] = [];
  let replayImpl = over?.replay ?? (async (_r: RoomId, _s: number): Promise<WsEnvelope[]> => []);
  const sock = new RoomSocket('ws://gw.test/ws', {
    replayFetch: (r, s) => {
      replayCalls.push(s);
      return replayImpl(r, s);
    },
    wsCtor: MockWebSocket as unknown as WebSocketCtor,
    rng: over?.rng ?? (() => 1),
    now: () => 1000,
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    ...over?.opts,
  });
  const seen: number[] = [];
  sock.on('chat.typing', (ev) => {
    seen.push(ev.seq);
  });
  return {
    timers,
    sock,
    seen,
    replayCalls,
    setReplay: (f: typeof replayImpl) => {
      replayImpl = f;
    },
  };
};

/** The frames the APP sent. Heartbeats are the socket's own traffic and every
 *  open now starts with one, so assertions about app envelopes must exclude them. */
const appFrames = (sent: readonly string[]): string[] =>
  sent.filter((raw) => !raw.includes('"clock.ping"'));

describe('RoomSocket', () => {
  it('emits in-order events and drops duplicates', () => {
    const { sock, seen, replayCalls } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(typingEvt(room, 1));
    ws.message(typingEvt(room, 2));
    ws.message(typingEvt(room, 2));
    ws.message(typingEvt(room, 1));
    expect(seen).toEqual([1, 2]);
    expect(replayCalls).toEqual([]);
    expect(sock.lastSeq).toBe(2);
  });

  it('carries the access token in a subprotocol, never in the URL', () => {
    // A URL credential lands in every access log between client and server;
    // the subprotocol slot is the one header a browser WebSocket can write.
    const { sock } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok_secret');
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).not.toContain('tok_secret');
    expect(ws.url).toContain(`roomId=${room}`);
    expect(ws.protocols).toEqual(['gather.auth.tok_secret']);
  });

  it('gap triggers exactly one replay and re-emits missing events in order without dupes', async () => {
    const { sock, seen, replayCalls, setReplay } = setup();
    const room = rid('r1');
    setReplay(
      async () =>
        [typingEvt(room, 3), typingEvt(room, 4), typingEvt(room, 5)] as unknown as WsEnvelope[],
    );
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(typingEvt(room, 1));
    ws.message(typingEvt(room, 2));
    ws.message(typingEvt(room, 5));
    await tick();
    // 5 emitted exactly once: the replay copy; the buffered live copy is deduped.
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(replayCalls).toEqual([2]);
    expect(sock.lastSeq).toBe(5);
  });

  it('live events arriving during replay are buffered and flushed in order', async () => {
    const { sock, seen, replayCalls, setReplay } = setup();
    const room = rid('r1');
    let release: ((envs: WsEnvelope[]) => void) | null = null;
    setReplay(
      () =>
        new Promise<WsEnvelope[]>((resolve) => {
          release = resolve;
        }),
    );
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(typingEvt(room, 1));
    ws.message(typingEvt(room, 4)); // gap -> replay starts
    ws.message(typingEvt(room, 5)); // live, buffered while replay pending
    ws.message(typingEvt(room, 6)); // live, buffered while replay pending
    release!([typingEvt(room, 2), typingEvt(room, 3)] as unknown as WsEnvelope[]);
    await tick();
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(replayCalls).toEqual([1]);
  });

  it('reconnects with backoff, resubscribes, replays from lastSeq once', async () => {
    const { timers, sock, seen, replayCalls, setReplay } = setup({ rng: () => 1 });
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws1 = MockWebSocket.instances[0]!;
    ws1.open();
    ws1.message(typingEvt(room, 1));
    ws1.message(typingEvt(room, 2));
    ws1.end(); // unexpected close
    expect(sock.status).toBe('reconnecting');
    // base 500 * 2^0 * (0.5 + 0.5 * rng=1) = 500; the heartbeat timer was cleared on close.
    expect(timers.delays()).toEqual([500]);
    setReplay(async () => [typingEvt(room, 3)] as unknown as WsEnvelope[]);
    timers.runNext();
    expect(MockWebSocket.instances.length).toBe(2);
    const ws2 = MockWebSocket.instances[1]!;
    expect(ws2.url).toBe(ws1.url);
    ws2.open();
    await tick();
    expect(sock.status).toBe('open');
    expect(seen).toEqual([1, 2, 3]);
    expect(replayCalls).toEqual([2]);
    ws2.message(typingEvt(room, 3)); // live dupe of the replayed event
    expect(seen).toEqual([1, 2, 3]);
    ws2.message(typingEvt(room, 4));
    expect(seen).toEqual([1, 2, 3, 4]);
    ws2.end();
    // The attempt counter resets once a socket has carried a server frame (this
    // one carried several), so the second drop backs off from attempt 0 again:
    // 500ms, not 1000ms.
    expect(timers.delays()).toEqual([500]);
  });

  it('send queues while connecting and flushes on open; heartbeat pings every 5s and pongs feed the clock', () => {
    const { timers, sock } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    sock.send('chat.typing', { typing: true });
    expect(ws.sent).toEqual([]);
    ws.open();
    // The queued envelope flushes first, then the immediate opening ping.
    expect(ws.sent.length).toBe(2);
    const first = JSON.parse(ws.sent[0]!) as { type: string; seq: number; roomId: string };
    expect(first.type).toBe('chat.typing');
    expect(first.seq).toBe(0);
    expect(first.roomId).toBe('r1');
    expect(timers.delays()).toEqual([5000]);
    timers.runNext();
    expect(ws.sent.length).toBe(3);
    const ping = JSON.parse(ws.sent[2]!) as { type: string; payload: { clientTs: number } };
    expect(ping.type).toBe('clock.ping');
    expect(ping.payload.clientTs).toBe(1000);
    // The next heartbeat is rescheduled immediately after firing.
    expect(timers.delays()).toEqual([5000]);
    ws.message(pongEvt(room, 600, 5000));
    // rtt = 1000 - 600 = 400; offset = 5000 - (600 + 400/2) = 4200.
    expect(sock.clock.offsetMs()).toBe(4200);
    expect(sock.clock.sampleCount()).toBe(1);
    expect(sock.clock.serverNow(1000)).toBe(5200);
    ws.message(pongEvt(room, 800, 5300));
    // rtt = 200; sample offset = 5300 - (800 + 200/2) = 4400;
    // EWMA alpha 0.25: 4200 + 0.25 * (4400 - 4200) = 4250.
    expect(sock.clock.offsetMs()).toBeCloseTo(4250, 10);
  });

  it('sends the first clock.ping on open, without waiting a whole heartbeat', () => {
    // Every ms before the first pong is a ms the app projects the room's
    // position against an offset of 0 that it cannot tell from a real one.
    const { timers, sock } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    expect(ws.sent).toEqual([]);
    ws.open();
    const types = ws.sent.map((s) => (JSON.parse(s) as { type: string }).type);
    expect(types).toEqual(['clock.ping']);
    // Exactly one timer, on the normal cadence — the opening ping does not add
    // a second heartbeat chain.
    expect(timers.delays()).toEqual([5000]);
    expect(sock.clockReady).toBe(false);
    ws.message(pongEvt(room, 600, 5000));
    expect(sock.clockReady).toBe(true);
    expect(sock.clock.offsetMs()).toBe(4200);
  });

  it('pings immediately on every reconnect too, not just the first open', () => {
    const { timers, sock } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws1 = MockWebSocket.instances[0]!;
    ws1.open();
    ws1.end();
    timers.runNext(); // backoff elapses
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();
    expect(ws2.sent.map((s) => (JSON.parse(s) as { type: string }).type)).toEqual(['clock.ping']);
    expect(timers.delays()).toEqual([5000]);
  });

  it('the opening ping counts once against the missed-pong watchdog', () => {
    const { timers, sock } = setup({ opts: { maxMissedPongs: 3 } });
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    const pings = () => ws.sent.filter((s) => s.includes('clock.ping')).length;
    // One ping per tick, opening ping included: 3 pings, not 4, before the
    // streak hits the limit.
    expect(pings()).toBe(1);
    timers.runNext();
    expect(pings()).toBe(2);
    timers.runNext();
    expect(pings()).toBe(3);
    expect(sock.status).toBe('open');
    timers.runNext();
    expect(sock.status).toBe('reconnecting');
    expect(pings()).toBe(3);
  });

  it('an onStatus handler that closes on open suppresses the opening ping', () => {
    // The ping is sent inline from handleOpen, so it must still obey the same
    // "is this socket actually open" guard the scheduled ticks obey.
    const { timers, sock } = setup();
    sock.connect(rid('r1'), 'tok');
    const ws = MockWebSocket.instances[0]!;
    sock.onStatus((status) => {
      if (status === 'open') sock.close();
    });
    ws.open();
    expect(ws.sent).toEqual([]);
    expect(timers.delays()).toEqual([]);
  });

  it('a confirmed device-clock step re-anchors the socket clock in one move', () => {
    // The signal apps poll to learn the clock moved under them (see
    // DriftController.noteHostSeek).
    const { timers, sock } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    // now() is fixed at 1000, so each pong's rtt is (1000 - clientTs).
    ws.message(pongEvt(room, 1000, 1000)); // offset 0
    expect(sock.clock.offsetMs()).toBe(0);
    expect(sock.clock.reanchorCount()).toBe(0);
    timers.runNext();
    ws.message(pongEvt(room, 1000, 31_000)); // +30s jump: held, not smoothed
    expect(sock.clock.offsetMs()).toBe(0);
    timers.runNext();
    ws.message(pongEvt(room, 1000, 31_000)); // confirmed
    expect(sock.clock.offsetMs()).toBe(30_000);
    expect(sock.clock.reanchorCount()).toBe(1);
    expect(sock.clock.lastReanchorMs()).toBe(30_000);
  });

  it('close() is final: no reconnect scheduled', () => {
    const { timers, sock } = setup();
    sock.connect(rid('r1'), 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    sock.close();
    expect(sock.status).toBe('closed');
    expect(timers.delays()).toEqual([]);
    expect(ws.closeCalls).toBe(1);
  });

  it('invalid frames are ignored', () => {
    const { sock, seen } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.onmessage?.({ data: 'not json' });
    ws.message({ type: 'nope', roomId: 'r1', seq: 9, ts: 1, payload: {} });
    expect(seen).toEqual([]);
    expect(sock.lastSeq).toBe(0);
  });

  it('connect() with initialSeq joins at the live tip: no history replay, gap detection from the seed', async () => {
    const { sock, seen, replayCalls, setReplay } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok', { initialSeq: 41 });
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    // First live event after the seeded tip is 'next' — no replay of the
    // room's entire history from seq 0.
    ws.message(typingEvt(room, 42));
    expect(seen).toEqual([42]);
    expect(replayCalls).toEqual([]);
    expect(sock.lastSeq).toBe(42);
    // A real gap past the seed still backfills from the tracker, not 0.
    setReplay(async () => [typingEvt(room, 43)] as unknown as WsEnvelope[]);
    ws.message(typingEvt(room, 44));
    await tick();
    expect(seen).toEqual([42, 43, 44]);
    expect(replayCalls).toEqual([42]);
  });

  it('connect() to a DIFFERENT room while active throws CONFLICT; same room is idempotent', () => {
    const { sock } = setup();
    sock.connect(rid('r1'), 'tok');
    expect(MockWebSocket.instances.length).toBe(1);
    sock.connect(rid('r1'), 'tok'); // idempotent
    expect(MockWebSocket.instances.length).toBe(1);
    expect(() => {
      sock.connect(rid('r2'), 'tok');
    }).toThrowError(ApiError);
    try {
      sock.connect(rid('r2'), 'tok');
    } catch (err) {
      expect((err as ApiError).code).toBe('CONFLICT');
    }
  });

  it('queued sends never leak into a later session or another room', () => {
    const { sock } = setup();
    sock.connect(rid('r1'), 'tok');
    sock.send('chat.typing', { typing: true }); // queued while connecting
    sock.close();
    sock.connect(rid('r2'), 'tok');
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();
    // The room-A envelope must not be flushed into room B's socket.
    expect(appFrames(ws2.sent)).toEqual([]);
  });

  it('drops events from a foreign room instead of poisoning the seq tracker', () => {
    const { sock, seen, replayCalls } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(typingEvt(rid('r2'), 50000)); // misrouted frame
    expect(seen).toEqual([]);
    expect(replayCalls).toEqual([]);
    expect(sock.lastSeq).toBe(0);
    ws.message(typingEvt(room, 1)); // real stream is unaffected
    expect(seen).toEqual([1]);
    expect(sock.lastSeq).toBe(1);
  });

  it('a transient replay failure is retried with backoff — missed events are still delivered exactly once', async () => {
    const losses: { roomId: RoomId; sinceSeq: number }[] = [];
    const { timers, sock, seen, replayCalls, setReplay } = setup({
      opts: {
        replayRetryAttempts: 3,
        replayRetryDelayMs: 100,
        onGapLoss: (info) => {
          losses.push(info);
        },
      },
    });
    const room = rid('r1');
    let calls = 0;
    setReplay(async () => {
      calls += 1;
      if (calls === 1) throw new Error('replay endpoint hiccup');
      return [typingEvt(room, 3), typingEvt(room, 4)] as unknown as WsEnvelope[];
    });
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(typingEvt(room, 1));
    ws.message(typingEvt(room, 2));
    ws.message(typingEvt(room, 5)); // gap: 3, 4 missing
    await tick();
    // First attempt failed; retry is pending, nothing lost or flushed early.
    expect(seen).toEqual([1, 2]);
    // Pending: 5000ms heartbeat + the 100ms replay retry (runNext picks 100).
    expect(timers.delays()).toEqual([5000, 100]);
    timers.runNext();
    await tick();
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(replayCalls).toEqual([2, 2]);
    expect(losses).toEqual([]);
    expect(sock.lastSeq).toBe(5);
  });

  it('an unanswered heartbeat streak forces a reconnect; any pong clears it', () => {
    const { timers, sock } = setup({ opts: { maxMissedPongs: 3 } });
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    // Three pings leave unanswered (the opening one plus two ticks); the socket
    // still looks open to the transport.
    timers.runNext();
    timers.runNext();
    expect(ws.sent.filter((s) => s.includes('clock.ping')).length).toBe(3);
    expect(sock.status).toBe('open');
    // Next tick: the streak is at the limit — the half-open socket is dropped.
    timers.runNext();
    expect(sock.status).toBe('reconnecting');
    expect(ws.closeCalls).toBe(1);
    expect(MockWebSocket.instances.length).toBe(1);
    timers.runNext(); // backoff elapses
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();
    // A slow-but-alive connection answers eventually: every pong resets the
    // streak, so the watchdog never fires.
    for (let i = 0; i < 10; i += 1) {
      timers.runNext();
      timers.runNext();
      ws2.message(pongEvt(room, 1000, 2000));
    }
    expect(sock.status).toBe('open');
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('a 4403 close is terminal: no reconnect, and the reason is surfaced', () => {
    const closes: { code: number; reason: string }[] = [];
    const { timers, sock } = setup({
      opts: {
        onTerminalClose: (info) => {
          closes.push(info);
        },
      },
    });
    sock.connect(rid('r1'), 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.end(4403, 'banned');
    expect(sock.status).toBe('closed');
    expect(timers.delays()).toEqual([]);
    expect(MockWebSocket.instances.length).toBe(1);
    expect(closes).toEqual([{ code: 4403, reason: 'banned' }]);
    expect(sock.closeInfo).toEqual({ code: 4403, reason: 'banned' });
  });

  it('a 4404 close is terminal and falls back to a readable reason', () => {
    const { timers, sock } = setup();
    sock.connect(rid('r1'), 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.end(4404);
    expect(sock.status).toBe('closed');
    expect(timers.delays()).toEqual([]);
    expect(sock.closeInfo?.code).toBe(4404);
    expect(sock.closeInfo?.reason).toBe('this room no longer exists');
  });

  it('a 4401 close retries exactly once (the app rotates the token), then gives up', () => {
    const closes: { code: number; reason: string }[] = [];
    const { timers, sock } = setup({
      opts: {
        onTerminalClose: (info) => {
          closes.push(info);
        },
      },
    });
    sock.connect(rid('r1'), 'tok');
    const ws1 = MockWebSocket.instances[0]!;
    ws1.open();
    ws1.end(4401, 'invalid token');
    // One retry: the app refreshes its access token on this transition.
    expect(sock.status).toBe('reconnecting');
    expect(closes).toEqual([]);
    timers.runNext();
    const ws2 = MockWebSocket.instances[1]!;
    ws2.end(4401, 'invalid token');
    // The fresh credentials were refused too — retrying forever would be a lie.
    expect(sock.status).toBe('closed');
    expect(timers.delays()).toEqual([]);
    expect(closes).toEqual([{ code: 4401, reason: 'invalid token' }]);
  });

  it('a 4401 budget survives the open-then-rejected cycle the hub actually performs', () => {
    const closes: { code: number; reason: string }[] = [];
    const { timers, sock } = setup({
      opts: {
        onTerminalClose: (info) => {
          closes.push(info);
        },
      },
    });
    sock.connect(rid('r1'), 'tok');
    // services/api/src/ws/hub.ts finishes the WebSocket handshake and only THEN
    // authorizes, so a rejected socket OPENS first. Every retry therefore looked
    // like a brand-new session, refunded the one-shot budget, and looped forever.
    for (let i = 0; i < 6 && sock.status !== 'closed'; i += 1) {
      const ws = MockWebSocket.instances[i]!;
      ws.open();
      ws.end(4401, 'invalid token');
      if (sock.status === 'reconnecting') timers.runNext();
    }
    expect(sock.status).toBe('closed');
    // One original attempt plus exactly one retry — not an endless stream.
    expect(MockWebSocket.instances.length).toBe(2);
    expect(timers.delays()).toEqual([]);
    expect(closes).toEqual([{ code: 4401, reason: 'invalid token' }]);
  });

  it('a socket that carried real traffic gets a fresh 4401 budget', () => {
    const { timers, sock } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws1 = MockWebSocket.instances[0]!;
    ws1.open();
    ws1.end(4401, 'invalid token'); // spends the budget
    timers.runNext();
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();
    // This session is genuine: the server talked to it. A later 4401 (the
    // session was revoked mid-call) is a NEW situation and buys its own retry.
    ws2.message(typingEvt(room, 1));
    ws2.end(4401, 'session revoked');
    expect(sock.status).toBe('reconnecting');
    expect(sock.closeInfo).toBeNull();
  });

  it('an ordinary transport close still reconnects', () => {
    const { sock } = setup();
    sock.connect(rid('r1'), 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.end(1006);
    expect(sock.status).toBe('reconnecting');
    expect(sock.closeInfo).toBeNull();
  });

  it('close({ preserveQueue: true }) keeps unsent envelopes across a token rotation', () => {
    const { sock } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    const ws1 = MockWebSocket.instances[0]!;
    ws1.open();
    ws1.end(); // dropped: the app is now reconnecting
    // The user types a message while the socket is down.
    sock.send('chat.typing', { typing: true });
    // The app rotates the access token: bounce the socket, keep the envelope.
    sock.close({ preserveQueue: true });
    sock.connect(room, 'tok2');
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();
    const flushed = appFrames(ws2.sent);
    expect(flushed.length).toBe(1);
    const sent = JSON.parse(flushed[0]!) as { type: string };
    expect(sent.type).toBe('chat.typing');
  });

  it('a plain close() still drops queued envelopes', () => {
    const { sock } = setup();
    const room = rid('r1');
    sock.connect(room, 'tok');
    sock.send('chat.typing', { typing: true });
    sock.close();
    sock.connect(room, 'tok');
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();
    expect(appFrames(ws2.sent)).toEqual([]);
  });

  it('exhausted replay retries surface onGapLoss, then flush leniently', async () => {
    const losses: { roomId: RoomId; sinceSeq: number }[] = [];
    const { timers, sock, seen, replayCalls, setReplay } = setup({
      opts: {
        replayRetryAttempts: 2,
        replayRetryDelayMs: 100,
        onGapLoss: (info) => {
          losses.push(info);
        },
      },
    });
    const room = rid('r1');
    setReplay(async () => {
      throw new Error('replay endpoint down');
    });
    sock.connect(room, 'tok');
    const ws = MockWebSocket.instances[0]!;
    ws.open();
    ws.message(typingEvt(room, 1));
    ws.message(typingEvt(room, 2));
    ws.message(typingEvt(room, 5)); // gap: 3, 4 missing
    await tick();
    expect(seen).toEqual([1, 2]); // first failure -> retry pending
    timers.runNext();
    await tick();
    // Second (final) failure: loss surfaced, buffered 5 emitted leniently.
    expect(seen).toEqual([1, 2, 5]);
    expect(losses).toEqual([{ roomId: room, sinceSeq: 2 }]);
    expect(replayCalls).toEqual([2, 2]);
    expect(sock.lastSeq).toBe(5);
  });
});
