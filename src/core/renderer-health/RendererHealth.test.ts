import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The renderer-health signal.
 *
 * Small, but it is the thing standing between a lost WebGL context and a
 * permanently black canvas, so its edges are worth pinning down — particularly
 * that one driver reset means one rebuild, not one per canvas on the page.
 */

async function fresh() {
  vi.resetModules();
  const mod = await import("./RendererHealth");
  return mod.getRendererHealth();
}

beforeEach(() => {
  vi.resetModules();
});

describe("RendererHealth", () => {
  it("starts healthy, having lost nothing", async () => {
    const health = await fresh();

    expect(health.state.lost).toBe(false);
    expect(health.state.generation).toBe(0);
    expect(health.state.lastLostAt).toBeNull();
  });

  it("bumps the generation on a loss", async () => {
    const health = await fresh();
    health.reportLost();

    // The generation is what a scene puts on its Canvas key, so this number
    // changing is the entire recovery mechanism.
    expect(health.state.lost).toBe(true);
    expect(health.state.generation).toBe(1);
    expect(health.state.lastLostAt).toBeTypeOf("number");
  });

  it("counts one driver reset as one rebuild, not one per canvas", async () => {
    const health = await fresh();

    // A GPU reset fires webglcontextlost on every canvas on the page. Three
    // canvases must not mean three remounts of everything.
    health.reportLost();
    health.reportLost();
    health.reportLost();

    expect(health.state.generation).toBe(1);
  });

  it("clears once a replacement renderer mounts", async () => {
    const health = await fresh();
    health.reportLost();
    health.reportHealthy();

    expect(health.state.lost).toBe(false);
    // The generation does not go back — the new canvas is keyed on it.
    expect(health.state.generation).toBe(1);
  });

  // This asserted the bug until 4.0.3. A second loss *does* count separately,
  // but "immediately, with a healthy in between" is not a second loss — it is
  // the same reset reaching the next canvas. So the intent stays and the clock
  // moves past the coalescing window to express it.
  it("counts a genuinely later loss separately", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const health = await fresh();
      health.reportLost();
      health.reportHealthy();

      vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
      health.reportLost();

      expect(health.state.generation).toBe(2);
      expect(health.state.lost).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * R2 in vv-lab's findings. `reportLost()` returned early while `lost` was
   * still set, so code that never called `reportHealthy()` survived exactly one
   * loss: the next was swallowed and the scene stayed black. vv-site's landing
   * demo died on its second "Drop Context" this way.
   */
  it("still rebuilds on a later loss when nothing reported healthy", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const health = await fresh();
      health.reportLost();

      vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
      health.reportLost();

      expect(health.state.generation).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("assumes the rebuild worked when nothing says so, and warns once", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const health = await fresh();
      health.reportLost();
      expect(health.state.lost).toBe(true);

      // A gate holds its scene in `recovering`, at reduced quality, while this
      // is set. Without the grace period a forgotten call held it there forever.
      vi.advanceTimersByTime(5000);
      expect(health.state.lost).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);

      health.reportLost();
      vi.advanceTimersByTime(5000);
      expect(health.state.generation).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stays quiet when the replacement reports healthy in time", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const health = await fresh();
      health.reportLost();
      health.reportHealthy();
      vi.advanceTimersByTime(10000);

      expect(health.state.lost).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  /**
   * The failure this window exists for.
   *
   * The `lost` flag alone only holds until a replacement mounts and reports
   * healthy. With several canvases that happens BETWEEN the queued
   * `webglcontextlost` events, so the sequence is lost, healthy, lost,
   * healthy — and every loss looked like a fresh failure.
   *
   * Measured on vv-site's /lab/context-loss before the fix: sixteen canvases,
   * one click, **generation 16**. Every bump remounts every scene, so one
   * reset produced sixteen rebuilds and up to 256 context creations against a
   * browser that keeps about sixteen. Cards lost that race and stayed black.
   */
  it("survives replacements reporting healthy between queued losses", async () => {
    const health = await fresh();

    for (let canvas = 0; canvas < 16; canvas++) {
      health.reportLost();
      // An earlier replacement finishes mounting and announces itself.
      health.reportHealthy();
    }

    expect(health.state.generation).toBe(1);
  });

  it("ignores a healthy report when nothing was lost", async () => {
    const health = await fresh();
    const seen: number[] = [];
    health.subscribe((s) => seen.push(s.generation));

    // Every renderer that mounts reports healthy. On a page that never lost a
    // context that is most mounts, and none of them are news.
    health.reportHealthy();
    health.reportHealthy();

    expect(seen).toHaveLength(1); // the initial call only
  });
});

/**
 * R10 in vv-lab's findings. The window above folds one reset reaching several
 * canvases into one rebuild, and it also swallowed a real loss: the
 * replacement that rebuild had just built, lost inside the same quarter
 * second. vv-site's landing demo went black on two quick clicks of "Drop
 * Context". `builtAt` tells the two apart.
 */
describe("RendererHealth — a replacement lost moments after it was built", () => {
  const at = (ms: number) => vi.setSystemTime(new Date(Date.UTC(2026, 0, 1) + ms));

  it("rebuilds again when the canvas the rebuild built is lost inside the window", async () => {
    vi.useFakeTimers();
    try {
      at(0);
      const health = await fresh();
      health.reportLost({ builtAt: 0 });
      expect(health.state.generation).toBe(1);

      // The replacement, built under generation 1, dies 100ms later.
      at(100);
      health.reportLost({ builtAt: 1 });
      expect(health.state.generation).toBe(2);
      expect(health.state.lost).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still folds the canvases the reset itself took into one rebuild", async () => {
    vi.useFakeTimers();
    try {
      at(0);
      const health = await fresh();
      // Sixteen canvases built under generation 0, one driver reset, and the
      // replacements reporting healthy between the queued losses.
      for (let canvas = 0; canvas < 16; canvas++) {
        at(canvas * 10);
        health.reportLost({ builtAt: 0 });
        health.reportHealthy();
      }
      expect(health.state.generation).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("judges a report without builtAt by the window alone, as before", async () => {
    vi.useFakeTimers();
    try {
      at(0);
      const health = await fresh();
      health.reportLost();
      at(100);
      health.reportLost();
      expect(health.state.generation).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts an older canvas's loss once the window has passed", async () => {
    vi.useFakeTimers();
    try {
      at(0);
      const health = await fresh();
      health.reportLost({ builtAt: 0 });

      // A scene that does not rebuild on the generation keeps its canvas, and a
      // later loss of it is real. builtAt only matters inside the window.
      at(2000);
      health.reportLost({ builtAt: 0 });
      expect(health.state.generation).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after three rebuilds in a row that each lose their own canvas, and says why once", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      at(0);
      const health = await fresh();
      health.reportLost({ builtAt: 0 });

      // A page with more canvases than the browser keeps contexts for: every
      // rebuild's new canvases are evicted as they are created.
      for (let i = 1; i <= 5; i++) {
        at(i * 50);
        health.reportLost({ builtAt: health.state.generation });
      }
      expect(health.state.generation).toBe(4);
      expect(warn).toHaveBeenCalledTimes(1);

      // A loss after a quiet moment is a new failure and rebuilds as normal.
      at(2000);
      health.reportLost({ builtAt: health.state.generation });
      expect(health.state.generation).toBe(5);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("RendererHealth — subscribers", () => {
  it("delivers the current state immediately", async () => {
    const health = await fresh();
    health.reportLost();

    let seen: { lost: boolean } | null = null;
    health.subscribe((s) => {
      seen = s;
    });

    // A gate mounting after the loss still has to know about it.
    expect(seen!.lost).toBe(true);
  });

  it("notifies on loss and on recovery", async () => {
    const health = await fresh();
    const seen: boolean[] = [];
    health.subscribe((s) => seen.push(s.lost));

    health.reportLost();
    health.reportHealthy();

    expect(seen).toEqual([false, true, false]);
  });

  it("stops notifying once unsubscribed", async () => {
    const health = await fresh();
    const seen: boolean[] = [];
    const off = health.subscribe((s) => seen.push(s.lost));

    off();
    health.reportLost();

    expect(seen).toEqual([false]);
  });
});
