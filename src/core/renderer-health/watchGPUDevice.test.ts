import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WebGPU device loss.
 *
 * WebGL fires an event when a context dies. WebGPU resolves a promise. Both end
 * at the same counter, and the interesting cases are the ones where a device
 * stops existing for a reason that is not a failure.
 */

async function fresh() {
  vi.resetModules();
  const health = await import("./RendererHealth");
  const watch = await import("./watchGPUDevice");
  return { ...health, ...watch };
}

/** A device whose `lost` promise this test controls. */
function makeDevice() {
  let settle: (info: { reason?: string } | undefined) => void = () => {};
  const lost = new Promise<{ reason?: string } | undefined>((res) => {
    settle = res;
  });
  return { device: { lost }, lose: settle };
}

beforeEach(() => {
  vi.resetModules();
});

describe("watchGPUDevice", () => {
  it("reports healthy as soon as it is handed a device", async () => {
    const { watchGPUDevice, getRendererHealth } = await fresh();
    const health = getRendererHealth();
    health.reportLost();
    expect(health.state.lost).toBe(true);

    const { device } = makeDevice();
    watchGPUDevice(device);

    expect(health.state.lost).toBe(false);
  });

  it("reports a lost device", async () => {
    const { watchGPUDevice, getRendererHealth } = await fresh();
    const health = getRendererHealth();
    const { device, lose } = makeDevice();
    watchGPUDevice(device);

    lose({ reason: "unknown" });
    await Promise.resolve();
    await Promise.resolve();

    expect(health.state.lost).toBe(true);
    expect(health.state.generation).toBe(1);
  });

  /**
   * The lesson the WebGL side paid for. Dropping a context on unmount reported
   * a loss after its replacement had reported healthy, which bumped the
   * generation and remounted everything, which unmounted more contexts. A
   * device the page destroyed on purpose is not one that needs replacing.
   */
  it("ignores a device destroyed on purpose", async () => {
    const { watchGPUDevice, getRendererHealth } = await fresh();
    const health = getRendererHealth();
    const { device, lose } = makeDevice();
    watchGPUDevice(device);

    lose({ reason: "destroyed" });
    await Promise.resolve();
    await Promise.resolve();

    expect(health.state.lost).toBe(false);
    expect(health.state.generation).toBe(0);
  });

  it("stays quiet after it is stopped", async () => {
    const { watchGPUDevice, getRendererHealth } = await fresh();
    const health = getRendererHealth();
    const { device, lose } = makeDevice();

    const stop = watchGPUDevice(device);
    stop();
    lose({ reason: "unknown" });
    await Promise.resolve();
    await Promise.resolve();

    // A promise cannot be un-awaited, so the handler still runs. What it must
    // not do is report, or a teardown that resolves `lost` afterwards rebuilds
    // a page that is already gone.
    expect(health.state.lost).toBe(false);
    expect(health.state.generation).toBe(0);
  });

  it("survives a lost promise that rejects instead of resolving", async () => {
    const { watchGPUDevice, getRendererHealth } = await fresh();
    const health = getRendererHealth();
    // Per spec `lost` resolves. An implementation that rejects is not evidence
    // the device died, and must not take down the page's error handling either.
    const device = { lost: Promise.reject(new Error("nonconformant")) };

    expect(() => watchGPUDevice(device)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(health.state.lost).toBe(false);
  });

  it("one device loss is one rebuild, like a context loss", async () => {
    const { watchGPUDevice, getRendererHealth } = await fresh();
    const health = getRendererHealth();

    // Several devices on one page, all taken by the same driver reset.
    const devices = Array.from({ length: 4 }, () => makeDevice());
    for (const d of devices) watchGPUDevice(d.device);
    for (const d of devices) d.lose({ reason: "unknown" });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(health.state.generation).toBe(1);
  });

  /**
   * R10, on the WebGPU side. A replacement device lost straight after the
   * rebuild requested it did not exist when the first device was lost, so it
   * is a new failure rather than the same reset reaching one more device.
   */
  it("rebuilds again when the replacement device is lost moments after it arrived", async () => {
    const { watchGPUDevice, getRendererHealth } = await fresh();
    const health = getRendererHealth();

    const first = makeDevice();
    watchGPUDevice(first.device);
    first.lose({ reason: "unknown" });
    await Promise.resolve();
    await Promise.resolve();
    expect(health.state.generation).toBe(1);

    // The rebuild requests a new device, and that one is lost too.
    const second = makeDevice();
    watchGPUDevice(second.device);
    second.lose({ reason: "unknown" });
    await Promise.resolve();
    await Promise.resolve();
    expect(health.state.generation).toBe(2);
  });
});
