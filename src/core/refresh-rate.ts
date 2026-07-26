/**
 * RefreshRateProbe — figures out the display's true vsync period.
 *
 * Why this exists: every "is the page healthy?" threshold in the runtime was
 * hardcoded against a 60Hz assumption, so a 120Hz display limping along at
 * 70fps read as perfectly fine. A frame budget only means something relative
 * to the rate the display can actually present at.
 *
 * How: rAF cannot fire FASTER than vsync, so the smallest interval we ever
 * observe IS the vsync period. Slow frames are jank and a minimum ignores
 * them for free — no percentiles, no sorting, no allocation.
 *
 * We keep the two smallest and estimate from the SECOND smallest, because a
 * raw minimum trusts a single sample. Duplicate rAF callbacks, clock
 * adjustments and resumed tabs all produce one impossibly short interval, and
 * a single one of those would otherwise pin the estimate to a rate the
 * display cannot do — for thousands of frames, since the minimum is only
 * allowed to recover slowly. Requiring an outlier to happen twice costs one
 * number and removes the failure mode.
 *
 * The minimum is allowed to drift upward very slowly so that moving a window
 * from a 144Hz monitor to a 60Hz one is picked up within a few seconds. On a
 * stable display the drift is cancelled every frame by the incoming sample,
 * so the estimate does not wander.
 *
 * Unknown rates snap to the nearest plausible display rate, and anything that
 * isn't close to one is rejected in favour of 60 — a page pinned at a steady
 * 30fps on a 60Hz panel must not be mistaken for a 30Hz display, or the
 * governor would congratulate it for keeping up.
 */

/** Display rates we're willing to believe. */
export const REFRESH_CANDIDATES = [60, 75, 90, 100, 120, 144, 165, 240] as const;

export const DEFAULT_HZ = 60;

/** Frames observed before the estimate is trusted. */
const MIN_SAMPLES = 8;
/** A candidate must be within this relative distance of the measurement. */
const TOLERANCE = 0.12;
/** Faster than 300Hz is a bogus sample (clock glitch, resumed tab). */
const MIN_INTERVAL_MS = 1000 / 300;
/** Slower than this is jank, not a display rate. */
const MAX_INTERVAL_MS = 1000 / 24;
/** Per-frame upward drift allowed on the running minimum (~1.27x per 600 frames). */
const DRIFT = 1.0004;

export class RefreshRateProbe {
  /** Smallest interval seen. Held only so a second one can confirm it. */
  private min1 = Infinity;
  /** Second smallest — the value the estimate is actually built from. */
  private min2 = Infinity;
  private samples = 0;
  private hzValue: number = DEFAULT_HZ;

  /** Best estimate of the display refresh rate in Hz. 60 until settled. */
  get hz(): number {
    return this.hzValue;
  }

  /** One presented frame, in milliseconds. */
  get frameBudgetMs(): number {
    return 1000 / this.hzValue;
  }

  /** True once enough frames have been seen for the estimate to mean anything. */
  get settled(): boolean {
    return this.samples >= MIN_SAMPLES;
  }

  reset(): void {
    this.min1 = Infinity;
    this.min2 = Infinity;
    this.samples = 0;
    this.hzValue = DEFAULT_HZ;
  }

  /** Feed one raw (unclamped) rAF interval in milliseconds. */
  push(intervalMs: number): void {
    if (!(intervalMs >= MIN_INTERVAL_MS) || intervalMs > MAX_INTERVAL_MS) return;

    // Let both minima creep upward so that moving the window to a slower
    // display is eventually noticed. On a stable display the incoming sample
    // cancels the drift every frame, so the estimate doesn't wander.
    if (this.min1 !== Infinity) this.min1 *= DRIFT;
    if (this.min2 !== Infinity) this.min2 *= DRIFT;

    if (intervalMs < this.min1) {
      this.min2 = this.min1;
      this.min1 = intervalMs;
    } else if (intervalMs < this.min2) {
      this.min2 = intervalMs;
    }

    this.samples++;
    if (this.samples < MIN_SAMPLES || this.min2 === Infinity) return;

    this.hzValue = snapToCandidate(1000 / this.min2);
  }
}

/**
 * Nearest believable display rate, or 60 when the measurement resembles none
 * of them (exported for tests).
 */
export function snapToCandidate(measuredHz: number): number {
  let best = DEFAULT_HZ;
  let bestDistance = Infinity;
  for (const candidate of REFRESH_CANDIDATES) {
    const distance = Math.abs(measuredHz - candidate) / candidate;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= TOLERANCE ? best : DEFAULT_HZ;
}
