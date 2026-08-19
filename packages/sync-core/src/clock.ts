/**
 * Client-side clock offset estimator fed by clock.ping/clock.pong round-trips.
 * Zero ambient time: every timestamp is supplied by the caller.
 */

/** One ping/pong round-trip. All values in ms. clientSendTs/clientRecvTs are on the
 *  client clock; serverTs is the server clock at the moment it handled the ping. */
export interface ClockSample {
  clientSendTs: number;
  serverTs: number;
  clientRecvTs: number;
}

/** Tunables for the clock offset estimator. */
export interface ClockEstimatorOptions {
  /** EWMA smoothing factor applied to accepted offset samples. Default 0.25. */
  alpha?: number;
  /** How many recent RTTs to keep for the outlier median. Default 10. */
  rttWindow?: number;
  /** Discard a sample when rtt > factor * median(recent RTTs). Default 2. */
  rttOutlierFactor?: number;
  /** Outlier filter only activates once this many RTTs are recorded. Default 3. */
  minSamplesForFilter?: number;
  /**
   * Offset movement, in ms, past which a sample is read as a device-clock STEP
   * (an NTP correction, a laptop resuming from sleep, a user setting the clock)
   * rather than as drift or noise. Default 1000. Pass 0 or Infinity to disable
   * step handling and get the pure EWMA this estimator had before it existed.
   *
   * WHY A STEP CANNOT BE SMOOTHED: below the threshold the EWMA is right — it
   * is averaging noise. Above it the EWMA is averaging a number that is simply
   * stale, and at the default alpha and one sample per heartbeat it needs ~10
   * samples (~50 s) to cover the move. For all of it the client projects the
   * room's position against an offset it could already know is wrong, and the
   * drift controller reads the difference as real drift and may hard-seek every
   * viewer once per tick to chase it.
   */
  stepThresholdMs?: number;
  /**
   * Consecutive over-threshold samples that must agree before the estimate
   * re-anchors. Default 2, and clamped to a floor of 2: the RTT-median filter
   * only sees asymmetry that shows up in the RTT, so a freak sample can reach
   * the offset math, and one sample must never be able to move the whole clock.
   */
  stepConfirmSamples?: number;
  /**
   * How far apart consecutive over-threshold samples may be and still count as
   * naming the SAME new offset. Default 250 — well above a heartbeat's worth of
   * jitter, well below `stepThresholdMs`, so a run of unrelated freak samples
   * scattered around the old estimate can never confirm itself into a step.
   */
  stepAgreementMs?: number;
}

/**
 * Snapshot for callers that must know how much to trust the offset — and
 * whether it just moved underneath them. See {@link ClockEstimator.state}.
 */
export interface ClockState {
  /** False while `offsetMs()` is still the 0 placeholder rather than a measurement. */
  hasEstimate: boolean;
  offsetMs: number;
  /** Accepted samples. RTT outliers and unconfirmed step candidates are not counted. */
  sampleCount: number;
  /** Re-anchors so far. A caller that remembers this value and compares it each
   *  tick learns that the device clock stepped. */
  reanchorCount: number;
  /** Signed size of the most recent re-anchor (new offset minus old); 0 before the first. */
  lastReanchorMs: number;
}

/** Median of a list of numbers; for an even count, the mean of the two middle values. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((lo ?? 0) + (hi ?? 0)) / 2;
}

/** Arithmetic mean; 0 for an empty list. */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Estimates (serverClock - clientClock) from ping/pong samples using an EWMA
 *  smoothed offset with an RTT-median outlier filter, plus step-vs-slew
 *  discipline: a confirmed jump in the device clock re-anchors the estimate in
 *  one move instead of being smoothed away over a minute. */
export class ClockEstimator {
  private readonly alpha: number;
  private readonly rttWindow: number;
  private readonly rttOutlierFactor: number;
  private readonly minSamplesForFilter: number;
  private readonly stepThresholdMs: number;
  private readonly stepConfirmSamples: number;
  private readonly stepAgreementMs: number;
  private readonly stepEnabled: boolean;

  private estimate = 0;
  private accepted = 0;
  private readonly rtts: number[] = [];
  /** Offsets of the consecutive over-threshold samples not yet confirmed as a step. */
  private stepRun: number[] = [];
  private reanchors = 0;
  private lastReanchor = 0;

  constructor(opts?: ClockEstimatorOptions) {
    this.alpha = opts?.alpha ?? 0.25;
    this.rttWindow = opts?.rttWindow ?? 10;
    this.rttOutlierFactor = opts?.rttOutlierFactor ?? 2;
    this.minSamplesForFilter = opts?.minSamplesForFilter ?? 3;
    this.stepThresholdMs = opts?.stepThresholdMs ?? 1000;
    this.stepConfirmSamples = Math.max(2, Math.floor(opts?.stepConfirmSamples ?? 2));
    this.stepAgreementMs = opts?.stepAgreementMs ?? 250;
    // Infinity is the natural "never step" and 0 the natural "off"; both mean
    // pure EWMA, which is exactly this estimator's original behaviour.
    this.stepEnabled = Number.isFinite(this.stepThresholdMs) && this.stepThresholdMs > 0;
  }

  /** Record an RTT, keeping only the most recent `rttWindow` entries. */
  private pushRtt(rtt: number): void {
    this.rtts.push(rtt);
    if (this.rtts.length > this.rttWindow) this.rtts.shift();
  }

  /** Feed one sample. Returns true if it updated the estimate, false if discarded
   *  — including a step candidate that is being held pending confirmation, which
   *  deliberately changes nothing until a second sample agrees with it. */
  addSample(sample: ClockSample): boolean {
    const { clientSendTs, serverTs, clientRecvTs } = sample;
    if (
      !Number.isFinite(clientSendTs) ||
      !Number.isFinite(serverTs) ||
      !Number.isFinite(clientRecvTs)
    ) {
      return false;
    }
    const rtt = clientRecvTs - clientSendTs;
    if (rtt < 0) return false;

    if (
      this.rtts.length >= this.minSamplesForFilter &&
      rtt > this.rttOutlierFactor * median(this.rtts)
    ) {
      this.pushRtt(rtt);
      return false;
    }

    this.pushRtt(rtt);
    const o = serverTs - (clientSendTs + rtt / 2);
    if (this.accepted === 0) {
      this.estimate = o;
      this.accepted = 1;
      return true;
    }
    if (this.stepEnabled && Math.abs(o - this.estimate) > this.stepThresholdMs) {
      return this.considerStep(o);
    }
    // An in-band sample withdraws any pending candidate: whatever those were,
    // the clock is plainly still where the estimate already says it is.
    if (this.stepRun.length > 0) this.stepRun = [];
    this.estimate = this.estimate + this.alpha * (o - this.estimate);
    this.accepted += 1;
    return true;
  }

  /**
   * An over-threshold offset. It is HELD, not folded in — a quarter of a number
   * we believe to be stale is still stale — until `stepConfirmSamples` samples
   * in a row agree on it, and only then adopted in a single move. Returns true
   * only for the sample that actually re-anchored.
   */
  private considerStep(o: number): boolean {
    // Candidates that disagree are noise, not one new offset: restart the run
    // from this sample rather than averaging two unrelated freaks together.
    if (this.stepRun.length > 0 && Math.abs(o - mean(this.stepRun)) > this.stepAgreementMs) {
      this.stepRun = [];
    }
    this.stepRun.push(o);
    if (this.stepRun.length < this.stepConfirmSamples) return false;
    // The mean of the confirming run, not its last member: every sample in it is
    // an independent measurement of the same new offset, so averaging them costs
    // nothing and halves the jitter we anchor onto.
    const target = mean(this.stepRun);
    this.lastReanchor = target - this.estimate;
    this.estimate = target;
    this.reanchors += 1;
    this.accepted += 1;
    this.stepRun = [];
    return true;
  }

  /**
   * Current estimate of (serverClock - clientClock).
   *
   * TRAP: this reads 0 before any sample is accepted, which is indistinguishable
   * from a genuinely zero offset — and a joining client asks for it well before
   * the first pong lands. Anything that DRIVES A CORRECTION (expectedPositionMs
   * feeding DriftController) must gate on {@link hasEstimate} first; only things
   * that merely display a time may use the placeholder.
   */
  offsetMs(): number {
    return this.accepted === 0 ? 0 : this.estimate;
  }

  /** clientNow + offsetMs(). Carries offsetMs's placeholder caveat: with no
   *  estimate yet this is just the client clock. */
  serverNow(clientNow: number): number {
    return clientNow + this.offsetMs();
  }

  /** True once at least one sample was accepted. */
  hasEstimate(): boolean {
    return this.accepted > 0;
  }

  /** Number of ACCEPTED samples so far. */
  sampleCount(): number {
    return this.accepted;
  }

  /**
   * How many times a confirmed device-clock step re-anchored the estimate. The
   * signal is a COUNTER rather than a callback so it cannot fire re-entrantly
   * from inside frame handling: a caller remembers the value and compares it on
   * its own tick. When it changes, every position projected from this clock just
   * jumped by {@link lastReanchorMs}.
   */
  reanchorCount(): number {
    return this.reanchors;
  }

  /** Signed size of the most recent re-anchor (new offset minus old); 0 before
   *  the first one. */
  lastReanchorMs(): number {
    return this.lastReanchor;
  }

  /** Snapshot for debug HUDs and for callers watching {@link reanchorCount}. */
  state(): ClockState {
    return {
      hasEstimate: this.accepted > 0,
      offsetMs: this.offsetMs(),
      sampleCount: this.accepted,
      reanchorCount: this.reanchors,
      lastReanchorMs: this.lastReanchor,
    };
  }
}
