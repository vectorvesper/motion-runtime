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
