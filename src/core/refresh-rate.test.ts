import { describe, it, expect } from "vitest";
import { RefreshRateProbe, snapToCandidate, DEFAULT_HZ } from "./refresh-rate";

function feed(probe: RefreshRateProbe, intervalMs: number, frames: number): void {
  for (let i = 0; i < frames; i++) probe.push(intervalMs);
}

describe("snapToCandidate", () => {
  it("snaps a measurement onto the nearest plausible display rate", () => {
    expect(snapToCandidate(59.94)).toBe(60);
    expect(snapToCandidate(119.88)).toBe(120);
    expect(snapToCandidate(143.6)).toBe(144);
    expect(snapToCandidate(240.2)).toBe(240);
  });

  it("rejects a rate that resembles no real display and falls back to 60", () => {
    // A page pinned at a steady 30fps on a 60Hz panel must not be mistaken
    // for a 30Hz display, or the governor would congratulate it.
    expect(snapToCandidate(30)).toBe(DEFAULT_HZ);
    expect(snapToCandidate(45)).toBe(DEFAULT_HZ);
  });
});

describe("RefreshRateProbe", () => {
  it("defaults to 60Hz before it has seen enough frames", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 1000 / 120, 3);
    expect(probe.settled).toBe(false);
    expect(probe.hz).toBe(60);
  });

  it("detects a 120Hz display", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 1000 / 120, 20);
    expect(probe.settled).toBe(true);
    expect(probe.hz).toBe(120);
    expect(probe.frameBudgetMs).toBeCloseTo(8.33, 1);
  });

  it("ignores jank: the fastest interval is vsync, the slow ones are drops", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 1000 / 60, 12); // real vsync
    feed(probe, 50, 40); // a long stretch of dropped frames
    expect(probe.hz).toBe(60);
  });

  it("reads a page stuck at half rate as its real 60Hz display", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 33.3, 40); // never once hits vsync
    expect(probe.hz).toBe(60); // 30 is not a believable display rate
  });

  it("is not poisoned by a single impossibly short interval", () => {
    // A duplicate rAF callback, a clock adjustment or a resumed tab can
    // produce one interval far shorter than the display can actually do. A
    // raw minimum would latch onto it and stay wrong for thousands of frames.
    const probe = new RefreshRateProbe();
    probe.push(4); // would imply a 250Hz display
    feed(probe, 1000 / 60, 30);
    expect(probe.hz).toBe(60);
  });

  it("believes a fast rate once it keeps happening", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 1000 / 120, 30);
    expect(probe.hz).toBe(120);
  });

  it("is not fooled by a burst of callbacks after a stall", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 1000 / 60, 60);
    expect(probe.hz).toBe(60);

    // Browsers deliver rAF in bursts after a stall: several back-to-back
    // callbacks with intervals far below one frame. Three of them, on a
    // display flatly running at 60.
    feed(probe, 1000 / 240, 3);
    feed(probe, 1000 / 60, 20);

    // The old probe kept a running minimum and only required an outlier
    // twice, so this pinned it at 240Hz — quartering the frame budget that
    // the conductor, the governor and the pressure classifier all read.
    expect(probe.hz).toBe(60);
  });

  it("still detects a fast display that a slow page is only half using", () => {
    const probe = new RefreshRateProbe();
    // A 120Hz panel where the page mostly manages 60, but not always. The
    // fast frames are real and recur, so they should be believed.
    for (let i = 0; i < 40; i++) {
      probe.push(1000 / 60);
      probe.push(1000 / 60);
      if (i % 3 === 0) probe.push(1000 / 120);
    }
    expect(probe.hz).toBe(120);
  });

  it("forgets a wrong answer within the window, not over thousands of frames", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 1000 / 120, 40);
    expect(probe.hz).toBe(120);

    // Moved to a 60Hz display. The old running minimum drifted upward at
    // 0.04% per frame and needed roughly 1700 frames — about half a minute —
    // to let go. A bounded window cannot hold a stale answer longer than the
    // window itself.
    feed(probe, 1000 / 60, 130);
    expect(probe.hz).toBe(60);
  });

  it("discards bogus sub-millisecond intervals", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 0.2, 30); // clock glitch / resumed tab burst
    expect(probe.settled).toBe(false);
    expect(probe.hz).toBe(60);
  });

  it("adapts when the window moves to a slower display", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 1000 / 144, 20);
    expect(probe.hz).toBe(144);
    feed(probe, 1000 / 60, 130);
    expect(probe.hz).toBe(60);
  });

  it("resets back to the default", () => {
    const probe = new RefreshRateProbe();
    feed(probe, 1000 / 120, 20);
    expect(probe.hz).toBe(120);
    probe.reset();
    expect(probe.hz).toBe(60);
    expect(probe.settled).toBe(false);
  });
});
