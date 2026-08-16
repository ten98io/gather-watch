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
    // The attempt counter resets on every successful open (handleOpen sets it to 0),
    // so the second drop backs off from attempt 0 again: 500ms, not 1000ms.
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
    expect(ws.sent.length).toBe(1);
    const first = JSON.parse(ws.sent[0]!) as { type: string; seq: number; roomId: string };
    expect(first.type).toBe('chat.typing');
    expect(first.seq).toBe(0);
    expect(first.roomId).toBe('r1');
    expect(timers.delays()).toEqual([5000]);
    timers.runNext();
    expect(ws.sent.length).toBe(2);
    const ping = JSON.parse(ws.sent[1]!) as { type: string; payload: { clientTs: number } };
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
    expect(ws2.sent).toEqual([]);
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
