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

  it("counts a second loss separately", async () => {
    const health = await fresh();
    health.reportLost();
    health.reportHealthy();
    health.reportLost();

    expect(health.state.generation).toBe(2);
    expect(health.state.lost).toBe(true);
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
