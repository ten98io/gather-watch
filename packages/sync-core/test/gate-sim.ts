import type { PlaybackState } from '@playin/contracts';
import { ClockEstimator } from '../src/clock';
import type { ClockSample } from '../src/clock';
import { DriftController } from '../src/drift';
import { applyServerState, expectedPositionMs } from '../src/playback';
import { mulberry32, uniform } from './prng';

export interface GateMetrics {
  /** Median of all pairwise |posA - posB| samples over the final 30 s. */
  medianPairwiseDriftMs: number;
  /** Worst pairwise drift seen in the final 30 s (informational). */
  maxPairwiseDriftMs: number;
  /** Per-client count of rate-sign flips (sign(rate-1) transitions +1 <-> -1) over the WHOLE run. */
  rateSignFlips: number[];
  /** Per-client final |actual - truePosition| (informational). */
  finalAbsErrorMs: number[];
  /**
   * Per-client median of |actual - truePosition(t)| sampled over the final
   * 30 s — SERVER-TRUTH tracking error, not just pairwise agreement. A no-op
   * controller scores ~280,000 ms here (it never applies the seek), so the
   * gate asserting on this is what makes a broken engine fail.
   */
  medianServerErrorMs: number[];
  /** Per-client count of 'nudge' decisions over the whole run. The media-clock
   *  skew below forces sustained rate-nudging, so this must be > 0 per client. */
  nudgeCounts: number[];
}

const CLIENTS = 4;
const TICK = 250;
const DURATION = 60_000;
const PING_INTERVAL = 5_000;
const SEEK_AT = 20_000;
const SEEK_TO = 300_000;

/** Broadcast PlaybackState (mediaRef null, queueIndex null, rate 1, playing). */
function broadcastState(seq: number, positionMs: number, serverTs: number): PlaybackState {
  return { mediaRef: null, positionMs, rate: 1, playing: true, serverTs, seq, queueIndex: null };
}

/** Server truth: playing from t=0 at rate 1 from position 0; seeks to SEEK_TO at SEEK_AT. */
function truePosition(t: number): number {
  return t < SEEK_AT ? t : SEEK_TO + (t - SEEK_AT);
}

type SimEvent =
  | { kind: 'ping'; arrival: number; client: number; sample: ClockSample }
  | { kind: 'state'; arrival: number; client: number; state: PlaybackState };

/** Deterministic 4-client sync simulation. All times in ms.
 *
 *  Fixed rand() draw order (documented so the schedule stays reproducible):
 *    1. trueOffset per client, in client order 0..3.
 *    2. Media-clock skew per client, in client order 0..3 (two draws each:
 *       sign, then magnitude in [0.2%, 0.5%]).
 *    3. State-broadcast deliveries: seq 1 for clients 0..3, then seq 2 for clients 0..3
 *       (one jitter draw per delivery).
 *    4. Ping schedules: client 0 with P ascending (0, 5000, ..., 55000), then client 1,
 *       etc.; each ping draws d1 then d2. */
export function runGateSimulation(seed: number): GateMetrics {
  const rand = mulberry32(seed);
  const jitter = () => uniform(rand, 5, 120);

  // 1. per-client true clock offsets: client wall clock = serverTime + trueOffset[i].
  const trueOffset: number[] = [];
  for (let i = 0; i < CLIENTS; i += 1) trueOffset.push(uniform(rand, -80, 80));

  // 2. per-client media-clock skew: real players never advance at exactly 1.0x
  //    (decode stalls, audio-clock drift). ±[0.2%, 0.5%] forces the rate-nudge
  //    path: without sustained nudging, 0.5% skew alone accrues ~300 ms drift
  //    over the 60 s run — far outside the gate. Magnitude floor 0.2%
  //    guarantees every client leaves the 60 ms deadband at least once.
  const skew: number[] = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    const sign = rand() < 0.5 ? -1 : 1;
    skew.push(sign * uniform(rand, 0.002, 0.005));
  }

  const clock: ClockEstimator[] = [];
  const drift: DriftController[] = [];
  const state: (PlaybackState | null)[] = [];
  const actual: number[] = [];
  const rate: number[] = [];
  const lastSign: number[] = [];
  const flips: number[] = [];
  const nudgeCounts: number[] = [];
  const serverErrSamples: number[][] = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    clock.push(new ClockEstimator());
    drift.push(new DriftController());
    state.push(null);
    actual.push(0);
    rate.push(1);
    lastSign.push(0);
    flips.push(0);
    nudgeCounts.push(0);
    serverErrSamples.push([]);
  }

  // 3. + 4. precompute all scheduled events in the fixed draw order above.
  const events: SimEvent[] = [];
  const broadcasts = [broadcastState(1, 0, 0), broadcastState(2, SEEK_TO, SEEK_AT)];
  for (const b of broadcasts) {
    for (let i = 0; i < CLIENTS; i += 1) {
      events.push({ kind: 'state', arrival: b.serverTs + jitter(), client: i, state: b });
    }
  }
  for (let i = 0; i < CLIENTS; i += 1) {
    const off = trueOffset[i] as number;
    for (let p = 0; p <= DURATION - PING_INTERVAL; p += PING_INTERVAL) {
      const clientSendTs = p + off;
      const d1 = jitter();
      const serverTs = p + d1;
      const d2 = jitter();
      const clientRecvTs = clientSendTs + d1 + d2;
      events.push({
        kind: 'ping',
        arrival: p + d1 + d2,
        client: i,
        sample: { clientSendTs, serverTs, clientRecvTs },
      });
    }
  }

  const delivered = new Array<boolean>(events.length).fill(false);
  const driftSamples: number[] = [];

  for (let t = 0; t <= DURATION; t += TICK) {
    // 1. Deliver due events (arrival <= t), in precomputed order.
    for (let e = 0; e < events.length; e += 1) {
      const ev = events[e] as SimEvent;
      if (delivered[e] || ev.arrival > t) continue;
      delivered[e] = true;
      const i = ev.client;
      if (ev.kind === 'ping') {
        (clock[i] as ClockEstimator).addSample(ev.sample);
      } else {
        state[i] = applyServerState(state[i] as PlaybackState | null, ev.state);
      }
    }

    for (let i = 0; i < CLIENTS; i += 1) {
      const st = state[i] as PlaybackState | null;

      // 2. Advance local playback with the PREVIOUS tick's rate, through the
      //    client's skewed media clock.
      if (t > 0 && st !== null && st.playing) {
        actual[i] = (actual[i] as number) + TICK * (rate[i] as number) * (1 + (skew[i] as number));
      }

      // 3. Decide and apply the drift correction.
      if (st !== null) {
        const clientNow = t + (trueOffset[i] as number);
        const serverNowEst = (clock[i] as ClockEstimator).serverNow(clientNow);
        const expected = expectedPositionMs(st, serverNowEst);
        const d = (drift[i] as DriftController).decide(expected, actual[i] as number);
        if (d.action === 'none') {
          rate[i] = 1;
        } else if (d.action === 'nudge') {
          rate[i] = d.rate;
          nudgeCounts[i] = (nudgeCounts[i] as number) + 1;
        } else {
          actual[i] = d.toMs;
          rate[i] = 1;
        }
      }

      // 4. Rate-sign flip counting (whole run).
      const s = Math.sign((rate[i] as number) - 1);
      if (s !== 0 && (lastSign[i] as number) !== 0 && s !== (lastSign[i] as number)) {
        flips[i] = (flips[i] as number) + 1;
      }
      if (s !== 0) lastSign[i] = s;
    }

    // 5. Pairwise drift + server-truth error sampling over the final 30 s.
    if (t >= 30_000) {
      for (let a = 0; a < CLIENTS; a += 1) {
        for (let b = a + 1; b < CLIENTS; b += 1) {
          driftSamples.push(Math.abs((actual[a] as number) - (actual[b] as number)));
        }
      }
      const truth = truePosition(t);
      for (let i = 0; i < CLIENTS; i += 1) {
        (serverErrSamples[i] as number[]).push(Math.abs((actual[i] as number) - truth));
      }
    }
  }

  const medianOf = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  };

  const medianPairwiseDriftMs = medianOf(driftSamples);
  const sorted = [...driftSamples].sort((x, y) => x - y);
  const maxPairwiseDriftMs = sorted.length > 0 ? (sorted[sorted.length - 1] as number) : 0;
  const finalAbsErrorMs = actual.map((a) => Math.abs(a - truePosition(DURATION)));
  const medianServerErrorMs = serverErrSamples.map((samples) => medianOf(samples));

  return {
    medianPairwiseDriftMs,
    maxPairwiseDriftMs,
    rateSignFlips: flips,
    finalAbsErrorMs,
    medianServerErrorMs,
    nudgeCounts,
  };
}
