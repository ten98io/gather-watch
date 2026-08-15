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

/** Estimates (serverClock - clientClock) from ping/pong samples using an EWMA
 *  smoothed offset with an RTT-median outlier filter. */
export class ClockEstimator {
  private readonly alpha: number;
  private readonly rttWindow: number;
  private readonly rttOutlierFactor: number;
  private readonly minSamplesForFilter: number;

  private estimate = 0;
  private accepted = 0;
  private readonly rtts: number[] = [];

  constructor(opts?: ClockEstimatorOptions) {
    this.alpha = opts?.alpha ?? 0.25;
    this.rttWindow = opts?.rttWindow ?? 10;
    this.rttOutlierFactor = opts?.rttOutlierFactor ?? 2;
    this.minSamplesForFilter = opts?.minSamplesForFilter ?? 3;
  }

  /** Record an RTT, keeping only the most recent `rttWindow` entries. */
  private pushRtt(rtt: number): void {
    this.rtts.push(rtt);
    if (this.rtts.length > this.rttWindow) this.rtts.shift();
  }

  /** Feed one sample. Returns true if it updated the estimate, false if discarded. */
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
    } else {
      this.estimate = this.estimate + this.alpha * (o - this.estimate);
    }
    this.accepted += 1;
    return true;
  }

  /** Current estimate of (serverClock - clientClock), 0 before any accepted sample. */
  offsetMs(): number {
    return this.accepted === 0 ? 0 : this.estimate;
  }

  /** clientNow + offsetMs(). */
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
}
