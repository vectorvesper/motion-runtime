import { describe, it, expect } from "vitest";
import { decide } from "./useSceneGate";

/**
 * The scene gate's decision, on its own.
 *
 * The React wrapper adds a ref, a dwell timer and three subscriptions. This is
 * the part that decides whether a scene runs and how much of it — the part
 * where being wrong costs a customer either a melted phone or a needlessly
 * ugly page.
 */

const base = {
  near: true,
  ready: true,
  started: true,
  tier: 0 as const,
  deviceTier: 0 as const,
  reducedMotion: false,
  qualityCause: "ok" as const,
  contextLost: false,
};

/**
 * Since 3.0 the gate reads the FUSED tier. The "only rendering is worth
 * degrading for" rule moved into AdaptiveQuality, so the cases that used to be
 * expressed here as pressure verdicts now live in `fuse()` and are tested in
 * AdaptiveQuality.test.ts. What arrives here is the decision already made,
 * plus the reason it was made, and the gate's job is to report it faithfully.
 */
const renderBound = { tier: 1 as const, qualityCause: "render" as const };
const frameRate = { tier: 1 as const, qualityCause: "frame-rate" as const };
/** The governor already refused to degrade, so the gate must not either. */
const heldBack = { tier: 0 as const, qualityCause: "held" as const };

describe("scene gate — before it can run at all", () => {
  it("shows a poster under reduced motion, wherever it is on the page", () => {
    const out = decide({ ...base, reducedMotion: true, near: false });

    // No point warming a scene that will never be allowed to run.
    expect(out.state).toBe("poster");
    expect(out.reason).toMatch(/reduced motion/);
  });

  it("shows a poster on a device that cannot render it", () => {
    const out = decide({ ...base, deviceTier: 2, tier: 2 });

    expect(out.state).toBe("poster");
  });

  it("stays dormant until it is near the viewport", () => {
    expect(decide({ ...base, started: false, near: false }).state).toBe("dormant");
  });

  it("warms while the page is still busy", () => {
    expect(decide({ ...base, started: false, ready: false }).state).toBe("warming");
  });
});

/**
 * `content: true`. The poster is right for a scene and wrong for a chart: a
 * visitor who asked for less motion still came for the chart. vv-lab's own
 * heavy-chart reference used the gate without it, and would never have shown
 * the chart to them.
 */
describe("scene gate — content a visitor came for", () => {
  const reduced = { reducedMotion: true, tier: 2 as const, qualityCause: "reduced-motion" as const };
  const floor = { deviceTier: 2 as const, tier: 2 as const, qualityCause: "device" as const };

  it("still waits to be near and for the page to afford it", () => {
    expect(decide({ ...base, ...reduced, content: true, started: false, near: false }).state).toBe("dormant");
    expect(decide({ ...base, ...reduced, content: true, started: false, ready: false }).state).toBe("warming");
  });

  it("mounts under reduced motion instead of going to the poster, and says why it is reduced", () => {
    const out = decide({ ...base, ...reduced, content: true });
    expect(out.state).toBe("constrained");
    expect(out.cause).toBe("reduced-motion");
  });

  it("mounts on a device below the floor too", () => {
    const out = decide({ ...base, ...floor, content: true });
    expect(out.state).toBe("constrained");
    expect(out.cause).toBe("device-floor");
  });

  it("leaves a scene's poster alone", () => {
    expect(decide({ ...base, ...reduced }).state).toBe("poster");
    expect(decide({ ...base, ...floor }).state).toBe("poster");
  });
});

describe("scene gate — surviving a scroll", () => {
  it("pauses instead of tearing down when scrolled off screen", () => {
    const out = decide({ ...base, near: false });

    // Rebuilding a WebGL context and re-uploading its textures costs far more
    // than leaving it mounted and drawing nothing.
    expect(out.state).toBe("idle");
    expect(out.reason).toMatch(/off screen/);
  });

  it("goes back to running when it comes back into view", () => {
    expect(decide({ ...base, near: true }).state).toBe("active");
  });

  it("never returns to dormant once it has started", () => {
    const out = decide({ ...base, near: false, ready: false });
    expect(out.state).not.toBe("dormant");
    expect(out.state).not.toBe("warming");
  });
});

describe("scene gate — a lost graphics context", () => {
  it("reports recovering when the context is taken away", () => {
    const out = decide({ ...base, contextLost: true });

    expect(out.state).toBe("recovering");
    expect(out.reason).toMatch(/graphics context/);
  });

  it("outranks a quality problem", () => {
    // No point reducing detail on a canvas that is not drawing anything.
    const out = decide({
      ...base, contextLost: true, ...renderBound,
    });

    expect(out.state).toBe("recovering");
  });

  it("ignores a loss elsewhere on a scene that never started", () => {
    // A driver reset reports page-wide. A scene still below the fold has no
    // context to have lost.
    const out = decide({ ...base, started: false, near: false, contextLost: true });

    expect(out.state).toBe("dormant");
  });

  it("still shows a poster under reduced motion", () => {
    const out = decide({ ...base, contextLost: true, reducedMotion: true });

    // Rebuilding something that is never going to run is wasted work.
    expect(out.state).toBe("poster");
  });
});

describe("scene gate — while running", () => {
  it("runs at full quality when nothing is wrong", () => {
    const out = decide(base);

    expect(out.state).toBe("active");
    expect(out.reason).toMatch(/full quality/);
  });

  it("reduces quality when the frame rate is not holding up", () => {
    expect(decide({ ...base, tier: 1 }).state).toBe("constrained");
  });

  /**
   * R3 in vv-lab's findings. Tier 2 fell through to "active", so the harder the
   * page struggled the more the gate asked of it: a managed R3F hero ran at
   * 10–12fps at full resolution while the governor read tier 2 the whole time.
   * Every other tier-2 case in this file also sets deviceTier 2, which takes
   * the poster branch before the tier is read, so none of them reached the
   * path that broke: tier 2 from the frame budget on a capable device.
   */
  it("keeps quality down when the frame rate collapses, not only when it sags", () => {
    const out = decide({ ...base, tier: 2, qualityCause: "frame-rate" });

    expect(out.state).toBe("constrained");
    expect(out.cause).toBe("frame-rate");
  });

  it("keeps quality down when rendering is the bottleneck at the worst tier", () => {
    const out = decide({ ...base, tier: 2, qualityCause: "render" });

    expect(out.state).toBe("constrained");
    expect(out.cause).toBe("render-bound");
  });
});

describe("scene gate — responding to the right kind of slow", () => {
  it("reduces quality when rendering is the bottleneck", () => {
    const out = decide({ ...base, ...renderBound });

    expect(out.state).toBe("constrained");
    expect(out.reason).toMatch(/rendering/);
  });

  it("still blames rendering when the frame rate has sagged with it", () => {
    // The realistic case, and the one that was wrong until 2.0.1. Rendering
    // being the bottleneck is what drags the tier down, so both conditions are
    // true together — nearly always. With the tier tested first, the specific
    // reason was unreachable and every render-bound scene reported the generic
    // one instead.
    const out = decide({ ...base, ...renderBound });

    expect(out.state).toBe("constrained");
    expect(out.reason).toMatch(/rendering/);
  });

  it("blames the frame rate when there is no render verdict to blame", () => {
    const out = decide({ ...base, ...frameRate });

    expect(out.state).toBe("constrained");
    expect(out.reason).toMatch(/frame rate/);
  });

  it("does NOT reduce quality when someone else is blocking the main thread", () => {
    const out = decide({ ...base, ...heldBack });

    // A smaller scene does not unblock a blocked thread. Degrading here makes
    // the page uglier and exactly as slow, which is the whole reason the
    // pressure classifier exists.
    expect(out.state).toBe("active");
  });

  it("does not reduce quality when our own work is the cause", () => {
    // The conductor's own shedding is the response to this. Rebuilding the
    // scene smaller would be a second, slower answer to a solved problem.
    expect(decide({ ...base, ...heldBack }).state).toBe("active");
  });

  it("ignores a render verdict it is not confident about", () => {
    // A realistic heavy scene measures about 0.52 in a real browser, and a
    // bare long-task hint is 0.3. Acting on the latter would be a guess.
    const weak = decide({ ...base, ...heldBack });
    const real = decide({ ...base, ...renderBound });

    expect(weak.state).toBe("active");
    expect(real.state).toBe("constrained");
  });

  it("does nothing on an unknown verdict", () => {
    expect(decide({ ...base }).state).toBe("active");
  });
});

describe("scene gate — ordering of the rules", () => {
  it("prefers a poster over reducing, on a device that cannot cope", () => {
    const out = decide({
      ...base, deviceTier: 2, tier: 2, qualityCause: "device",
    });

    expect(out.state).toBe("poster");
  });

  it("does not report render pressure while it is still warming", () => {
    const out = decide({
      ...base, started: false, ready: false, ...renderBound,
    });

    // Nothing is rendering yet, so whatever is loading the frame is not us.
    expect(out.state).toBe("warming");
  });

  it("gives a plain-language reason for every state", () => {
    const states = [
      decide({ ...base, reducedMotion: true }),
      decide({ ...base, deviceTier: 2 }),
      decide({ ...base, started: false, near: false }),
      decide({ ...base, started: false, ready: false }),
      decide({ ...base, near: false }),
      decide({ ...base, tier: 1 }),
      decide({ ...base, ...renderBound }),
      decide(base),
    ];

    for (const s of states) {
      expect(s.reason.length).toBeGreaterThan(8);
      // A reason a support thread can read, not a code.
      expect(s.reason).not.toMatch(/[_A-Z]{3,}/);
    }
  });
});

describe("scene gate — cause is the field you branch on", () => {
  it("names every state it can reach", () => {
    expect(decide({ ...base }).cause).toBe("ok");
    expect(decide({ ...base, reducedMotion: true }).cause).toBe("reduced-motion");
    expect(decide({ ...base, deviceTier: 2, tier: 2 }).cause).toBe("device-floor");
    expect(decide({ ...base, started: true, contextLost: true }).cause).toBe("context-lost");
    expect(decide({ ...base, started: false, near: false }).cause).toBe("not-near");
    expect(decide({ ...base, started: false, ready: false }).cause).toBe("waiting-for-headroom");
    expect(decide({ ...base, near: false }).cause).toBe("off-screen");
    expect(decide({ ...base, ...renderBound }).cause).toBe("render-bound");
    expect(decide({ ...base, ...frameRate }).cause).toBe("frame-rate");
  });

  it("distinguishes the two ways of arriving at constrained", () => {
    // Both read "constrained". Only cause says which, and up to 2.x the
    // generic one always won because tier was tested before pressure.
    expect(decide({ ...base, ...renderBound }).cause).toBe("render-bound");
    expect(decide({ ...base, ...frameRate }).cause).toBe("frame-rate");
  });
});
