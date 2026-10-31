/**
 * RefreshRateProbe: finds the display's true vsync period.
 *
 * A frame budget only means something relative to the rate the display can
 * present at. `frameBudgetMs` feeds the conductor's shed thresholds,
 * AnimationBudget's tiers and the pressure classifier's healthy check, so a
 * wrong estimate makes a healthy page degrade itself.
 *
 * rAF can't fire faster than vsync, so short intervals carry the information.
 * The smallest interval ever seen still isn't the period: after a stall, two
 * callbacks can arrive back to back, far closer than a frame. So the estimate
 * comes from a bounded window of recent intervals, and a fast interval has to
 * recur before it is believed. A burst adds two or three samples, and a real
 * 120Hz display adds them constantly. A wrong estimate can't outlive it.
 *
 * Unknown rates snap to the nearest plausible display rate, and anything not
 * close to one is rejected in favour of 60: a page pinned at a steady 30fps on
 * a 60Hz panel must not be mistaken for a 30Hz display.
 *
 * When a battery saver holds the page to 30fps, presentation-cap.ts sets the
 * conductor's budget to the capped rate and leaves this estimate alone.
 */

/** Display rates we're willing to believe. */
export const REFRESH_CANDIDATES = [60, 75, 90, 100, 120, 144, 165, 240] as const;

export const DEFAULT_HZ = 60;

/** Frames observed before the estimate is trusted. */
const MIN_SAMPLES = 8;
/**
 * How many recent intervals the estimate is built from. This bounds how long a
 * wrong answer can survive: about two seconds at 60Hz.
 */
const WINDOW = 128;
/**
 * How many samples in the window must sit near the candidate period before it
 * is believed. A post-stall burst contributes two or three. A display running
 * at that rate contributes most of the window, and one merely capable of it
 * while the page runs slower still contributes far more than this.
 */
const MIN_CORROBORATION = 6;
/** How close an interval must be to the candidate to corroborate it. */
const CORROBORATION_TOLERANCE = 1.15;
/** A candidate must be within this relative distance of the measurement. */
const TOLERANCE = 0.12;
/** Faster than 300Hz is a bogus sample (clock glitch, resumed tab). */
const MIN_INTERVAL_MS = 1000 / 300;
/** Slower than this is jank, not a display rate. */
const MAX_INTERVAL_MS = 1000 / 24;

export class RefreshRateProbe {
  /** Recent raw intervals. Bounded, so a bad estimate cannot outlive it. */
  private window = new Float32Array(WINDOW);
  private next = 0;
  private filled = 0;
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
    this.window.fill(0);
    this.next = 0;
    this.filled = 0;
    this.samples = 0;
    this.hzValue = DEFAULT_HZ;
  }

  /** Feed one raw (unclamped) rAF interval in milliseconds. */
  push(intervalMs: number): void {
    if (!(intervalMs >= MIN_INTERVAL_MS) || intervalMs > MAX_INTERVAL_MS) return;

    this.window[this.next] = intervalMs;
    this.next = (this.next + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;
    this.samples++;
    if (this.samples < MIN_SAMPLES) return;

    // Second smallest in the window: one impossibly short sample shouldn't
    // decide anything on its own.
    let min1 = Infinity;
    let min2 = Infinity;
    for (let i = 0; i < this.filled; i++) {
      const v = this.window[i];
      if (v < min1) {
        min2 = min1;
        min1 = v;
      } else if (v < min2) {
        min2 = v;
      }
    }
    if (min2 === Infinity) return;

    // The period has to recur. Without this a two-callback burst is
    // indistinguishable from a fast display.
    const limit = min2 * CORROBORATION_TOLERANCE;
    let near = 0;
    for (let i = 0; i < this.filled; i++) if (this.window[i] <= limit) near++;
    if (near < MIN_CORROBORATION) return;

    this.hzValue = snapToCandidate(1000 / min2);
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
