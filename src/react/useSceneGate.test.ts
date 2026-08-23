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
  pressure: "none",
  confidence: 1,
  contextLost: false,
};

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
      ...base, contextLost: true, tier: 1, pressure: "render", confidence: 1,
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
});

describe("scene gate — responding to the right kind of slow", () => {
  it("reduces quality when rendering is the bottleneck", () => {
    const out = decide({ ...base, pressure: "render", confidence: 0.6 });

    expect(out.state).toBe("constrained");
    expect(out.reason).toMatch(/rendering/);
  });

  it("does NOT reduce quality when someone else is blocking the main thread", () => {
    const out = decide({ ...base, pressure: "main-thread", confidence: 1 });

    // A smaller scene does not unblock a blocked thread. Degrading here makes
    // the page uglier and exactly as slow, which is the whole reason the
    // pressure classifier exists.
    expect(out.state).toBe("active");
  });

  it("does not reduce quality when our own work is the cause", () => {
    // The conductor's own shedding is the response to this. Rebuilding the
    // scene smaller would be a second, slower answer to a solved problem.
    expect(decide({ ...base, pressure: "runtime", confidence: 1 }).state).toBe("active");
  });

  it("ignores a render verdict it is not confident about", () => {
    // A realistic heavy scene measures about 0.52 in a real browser, and a
    // bare long-task hint is 0.3. Acting on the latter would be a guess.
    const weak = decide({ ...base, pressure: "render", confidence: 0.3 });
    const real = decide({ ...base, pressure: "render", confidence: 0.52 });

    expect(weak.state).toBe("active");
    expect(real.state).toBe("constrained");
  });

  it("does nothing on an unknown verdict", () => {
    expect(decide({ ...base, pressure: "unknown", confidence: 0 }).state).toBe("active");
  });
});

describe("scene gate — ordering of the rules", () => {
  it("prefers a poster over reducing, on a device that cannot cope", () => {
    const out = decide({
      ...base, deviceTier: 2, tier: 2, pressure: "render", confidence: 1,
    });

    expect(out.state).toBe("poster");
  });

  it("does not report render pressure while it is still warming", () => {
    const out = decide({
      ...base, started: false, ready: false, pressure: "render", confidence: 1,
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
      decide({ ...base, pressure: "render", confidence: 0.9 }),
      decide(base),
    ];

    for (const s of states) {
      expect(s.reason.length).toBeGreaterThan(8);
      // A reason a support thread can read, not a code.
      expect(s.reason).not.toMatch(/[_A-Z]{3,}/);
    }
  });
});
