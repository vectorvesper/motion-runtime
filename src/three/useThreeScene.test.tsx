// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import type { ThreeScene, ThreeSceneFrame, ThreeSceneHandle, UseThreeSceneOptions } from "./useThreeScene";

/**
 * The plain three.js adapter, against a renderer and a scene that record what
 * is done to them.
 *
 * jsdom has no WebGL, and these do not need one: the hook's whole job is what
 * happens to the renderer and the scene, and in what order, which a recording
 * fake shows exactly. That a real renderer lands at the right size, draws,
 * recovers and lets go is checked in real browsers by vv-lab.
 */

let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafId = 0;
let now = 0;
let observers: Array<{ callback: IntersectionObserverCallback; observed: Element[] }> = [];
let reducedMotion = false;

function crank(timeMs: number): void {
  now = timeMs;
  const pending = [...rafCallbacks.values()];
  rafCallbacks = new Map();
  for (const cb of pending) cb(timeMs);
}

function crankFrames(count: number): void {
  for (let i = 0; i < count; i++) crank(now + 16);
}

function intersect(is: boolean): void {
  for (const o of observers) {
    o.callback(
      o.observed.map((target) => ({ isIntersecting: is, target })) as unknown as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
  }
}

function setScreenRatio(ratio: number): void {
  Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  observers = [];
  reducedMotion = false;
  setScreenRatio(1);

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => rafCallbacks.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("reduce"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observed: Element[] = [];
      constructor(public callback: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  // The device probe needs a GPU to rate, or every scene is a poster.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) =>
      kind === "webgl2" ? { getExtension: () => null, getParameter: () => "Test GPU" } : null) as never,
  );
  vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(8);
  // jsdom lays nothing out. The scene's element is 800 by 600.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface FakeRenderer {
  id: number;
  domElement: HTMLCanvasElement;
  pixelRatio: number;
  width: number;
  height: number;
  draws: number;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number): void;
  render(): void;
  dispose(): void;
  forceContextLoss(): void;
  getContext(): { isContextLost(): boolean };
  /** What a driver reset does to it. */
  lose(): void;
}

function fakeThree(log: string[]) {
  const renderers: FakeRenderer[] = [];
  const renderer = (): FakeRenderer => {
    const id = renderers.length + 1;
    const canvas = document.createElement("canvas");
    let lost = false;
    const drop = () => {
      lost = true;
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    };
    const r: FakeRenderer = {
      id,
      domElement: canvas,
      pixelRatio: 0,
      width: 0,
      height: 0,
      draws: 0,
      setPixelRatio(value) {
        r.pixelRatio = value;
      },
      setSize(width, height) {
        r.width = width;
        r.height = height;
      },
      render() {
        r.draws++;
      },
      dispose() {
        log.push(`dispose renderer ${id}`);
      },
      // What three's does: lose the context, which fires the same event a
      // real failure fires.
      forceContextLoss() {
        log.push(`release context ${id}`);
        drop();
      },
      getContext() {
        return { isContextLost: () => lost };
      },
      lose: drop,
    };
    renderers.push(r);
    return r;
  };
  return { renderer, renderers };
}

/** One mesh whose geometry, material and texture say when they are freed. */
function fakeScene(log: string[], build: number) {
  const texture = { isTexture: true, dispose: () => log.push(`dispose texture ${build}`) };
  const material = { map: texture, dispose: () => log.push(`dispose material ${build}`) };
  const geometry = { dispose: () => log.push(`dispose geometry ${build}`) };
  const mesh = { geometry, material };
  const scene = {
    traverse(callback: (object: unknown) => void) {
      callback(scene);
      callback(mesh);
    },
  };
  const camera = {
    isPerspectiveCamera: true,
    aspect: 1,
    updateProjectionMatrix: () => log.push(`fit camera ${build}`),
  };
  return { scene, camera };
}

async function mountScene(
  overrides: Partial<UseThreeSceneOptions<FakeRenderer>> = {},
  { promised = false }: { promised?: boolean } = {},
) {
  vi.resetModules();
  const { useThreeScene } = await import("./useThreeScene");
  const { getRendererHealth } = await import("../core/renderer-health/RendererHealth");
  const log: string[] = [];
  const three = fakeThree(log);
  const frames: ThreeSceneFrame[] = [];
  const cameras: Array<{ aspect: number }> = [];
  let builds = 0;
  let latest: Omit<ThreeScene, "ref"> | null = null;

  const setup = ({ width, height }: { width: number; height: number }): ThreeSceneHandle => {
    builds++;
    log.push(`setup ${builds} at ${width}x${height}`);
    const { scene, camera } = fakeScene(log, builds);
    cameras.push(camera);
    return {
      scene,
      camera,
      update: (frame) => {
        frames.push({ ...frame });
      },
      resize: (w, h) => {
        log.push(`resize ${w}x${h}`);
      },
    };
  };

  function Hero() {
    const { ref, ...rest } = useThreeScene<FakeRenderer>({
      label: "hero",
      cost: "light",
      renderer: promised ? () => Promise.resolve(three.renderer()) : three.renderer,
      setup: promised ? (context) => Promise.resolve(setup(context)) : setup,
      ...overrides,
    });
    latest = rest;
    return <div ref={ref} />;
  }

  const view = render(<Hero />);
  return {
    view,
    log,
    three,
    frames,
    cameras,
    health: getRendererHealth(),
    scene: () => latest!,
    host: () => view.container.firstElementChild as HTMLElement,
  };
}

/** Bring the scene into view and let the gate open. */
async function open(): Promise<void> {
  await act(async () => intersect(true));
  await act(async () => crankFrames(8));
}

async function advance(count: number): Promise<void> {
  await act(async () => crankFrames(count));
}

describe("useThreeScene — building", () => {
  it("builds nothing until the scene is near and the page can afford it", async () => {
    const { three } = await mountScene();
    await advance(8);
    expect(three.renderers).toHaveLength(0);
  });

  it("builds into its element, at the element's size, once the gate opens", async () => {
    const { three, log, host } = await mountScene();
    await open();

    expect(three.renderers).toHaveLength(1);
    expect(three.renderers[0].domElement.parentElement).toBe(host());
    expect(log).toContain("setup 1 at 800x600");
    expect([three.renderers[0].width, three.renderers[0].height]).toEqual([800, 600]);
  });

  it("draws every frame once built", async () => {
    const { three } = await mountScene();
    await open();
    const drawn = three.renderers[0].draws;
    await advance(3);
    expect(three.renderers[0].draws).toBe(drawn + 3);
  });

  it("waits for a renderer and a scene that arrive as promises", async () => {
    const { three } = await mountScene({}, { promised: true });
    await open();
    await advance(3);
    expect(three.renderers).toHaveLength(1);
    expect(three.renderers[0].draws).toBeGreaterThan(0);
  });

  it("reports a setup that throws, and leaves the page alone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { three } = await mountScene({
      setup: () => {
        throw new Error("bad scene");
      },
    });
    await open();
    await advance(2);

    expect(error).toHaveBeenCalled();
    expect(three.renderers[0].draws).toBe(0);
  });
});

describe("useThreeScene — the screen", () => {
  it("draws a 1x screen at 1x, never supersampled", async () => {
    setScreenRatio(1);
    const { three, scene } = await mountScene();
    await open();
    await advance(2);
    expect(scene().quality).toBe("full");
    expect(three.renderers[0].pixelRatio).toBe(1);
  });

  it("caps a 3x screen at 2 at full quality", async () => {
    setScreenRatio(3);
    const { three } = await mountScene();
    await open();
    await advance(2);
    expect(three.renderers[0].pixelRatio).toBe(2);
  });

  it("takes caps of its own", async () => {
    setScreenRatio(3);
    const { three } = await mountScene({ maxDpr: { full: 1.5 } });
    await open();
    await advance(2);
    expect(three.renderers[0].pixelRatio).toBe(1.5);
  });

  it("stops drawing off screen, and keeps the renderer for when it comes back", async () => {
    const { three, log, scene } = await mountScene();
    await open();
    await advance(2);

    await act(async () => intersect(false));
    expect(scene().state).toBe("idle");
    const drawn = three.renderers[0].draws;
    await advance(5);
    expect(three.renderers[0].draws).toBe(drawn);
    expect(log).not.toContain("dispose renderer 1");

    await act(async () => intersect(true));
    await advance(2);
    expect(three.renderers[0].draws).toBeGreaterThan(drawn);
    expect(three.renderers).toHaveLength(1);
  });

  it("fits a perspective camera and calls resize before the first frame", async () => {
    const { log, cameras } = await mountScene();
    await open();
    await advance(1);
    expect(cameras[0].aspect).toBeCloseTo(800 / 600);
    expect(log).toContain("fit camera 1");
    expect(log).toContain("resize 800x600");
  });

  it("hands update the live quality, pixel ratio, size and time", async () => {
    setScreenRatio(2);
    const { frames } = await mountScene();
    await open();
    await advance(3);

    const last = frames.at(-1)!;
    expect(last).toMatchObject({ quality: "full", pixelRatio: 2, width: 800, height: 600 });
    expect(last.dt).toBeGreaterThan(0);
    expect(last.time).toBeGreaterThan(frames[0].time);
  });

  it("calls resize again when the pixel ratio changes, so a composer can follow", async () => {
    setScreenRatio(1);
    const { log } = await mountScene();
    await open();
    await advance(2);
    const before = log.filter((line) => line.startsWith("resize")).length;

    setScreenRatio(2);
    await advance(2);
    expect(log.filter((line) => line.startsWith("resize")).length).toBe(before + 1);
  });

  it("warns when its element has no size to draw into", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountScene();
    await open();
    await advance(2);
    expect(warn.mock.calls.some(([message]) => String(message).includes("no size"))).toBe(true);
  });
});

describe("useThreeScene — a lost graphics context", () => {
  it("rebuilds with a new renderer and a new scene, and frees the dead ones", async () => {
    const { three, log, health, host } = await mountScene();
    await open();
    await advance(2);

    await act(async () => three.renderers[0].lose());
    expect(health.state.generation).toBe(1);
    await advance(2);

    expect(three.renderers).toHaveLength(2);
    expect(log).toContain("setup 2 at 800x600");
    expect(log).toEqual(
      expect.arrayContaining(["dispose geometry 1", "dispose material 1", "dispose texture 1", "dispose renderer 1"]),
    );
    expect(three.renderers[0].domElement.isConnected).toBe(false);
    expect(three.renderers[1].domElement.parentElement).toBe(host());
    expect(three.renderers[1].draws).toBeGreaterThan(0);
  });

  it("says the rebuild worked once the replacement has drawn", async () => {
    const { three, health } = await mountScene();
    await open();
    await advance(2);

    await act(async () => three.renderers[0].lose());
    expect(health.state.lost).toBe(true);
    await advance(2);

    expect(three.renderers[1].draws).toBeGreaterThan(0);
    expect(health.state.lost).toBe(false);
  });

  /**
   * R10. The replacement did not exist when the first reset happened, so
   * losing it straight away is a new failure and gets a rebuild of its own.
   */
  it("rebuilds again when the replacement is lost moments after it was built", async () => {
    const { three, health } = await mountScene();
    await open();
    await advance(2);
    await act(async () => three.renderers[0].lose());
    await advance(2);

    await act(async () => three.renderers[1].lose());
    expect(health.state.generation).toBe(2);
    await advance(2);

    expect(three.renderers).toHaveLength(3);
    expect(three.renderers[2].draws).toBeGreaterThan(0);
  });

  it("carries the scene's clock across a rebuild", async () => {
    const { three, frames } = await mountScene();
    await open();
    await advance(5);
    const before = frames.at(-1)!.time;

    await act(async () => three.renderers[0].lose());
    await advance(2);
    expect(frames.at(-1)!.time).toBeGreaterThan(before);
  });
});

describe("useThreeScene — leaving", () => {
  it("frees the scene, then the renderer and its context, and takes the canvas out", async () => {
    const { three, log, view } = await mountScene();
    await open();
    await advance(2);
    view.unmount();

    expect(log).toEqual(
      expect.arrayContaining([
        "dispose geometry 1",
        "dispose material 1",
        "dispose texture 1",
        "dispose renderer 1",
        "release context 1",
      ]),
    );
    expect(log.indexOf("dispose geometry 1")).toBeLessThan(log.indexOf("dispose renderer 1"));
    expect(three.renderers[0].domElement.isConnected).toBe(false);
  });

  it("does not hear its own release of the context as a failure", async () => {
    const { health, view } = await mountScene();
    await open();
    await advance(2);
    view.unmount();

    expect(health.state.generation).toBe(0);
    expect(health.state.lost).toBe(false);
  });

  it("stops drawing once it is gone", async () => {
    const { three, view } = await mountScene();
    await open();
    await advance(2);
    view.unmount();

    const drawn = three.renderers[0].draws;
    crankFrames(3);
    expect(three.renderers[0].draws).toBe(drawn);
  });
});

describe("useThreeScene — reduced motion", () => {
  it("never builds the scene, and says so, so a still image can show", async () => {
    reducedMotion = true;
    const { three, scene } = await mountScene();
    await open();
    await advance(4);

    expect(three.renderers).toHaveLength(0);
    expect(scene().mounted).toBe(false);
    expect(scene().state).toBe("poster");
  });
});

describe("useThreeScene — a renderer that cannot be made", () => {
  it("reports it, and leaves the page alone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { scene } = await mountScene({
      renderer: () => {
        throw new Error("no WebGL here");
      },
    });
    await open();
    await advance(2);

    expect(error).toHaveBeenCalled();
    expect(scene().mounted).toBe(true);
  });
});

/**
 * A `WebGPURenderer`, by its shape: an `init()` to wait for, and a backend
 * holding the device. Nothing may draw before `init` resolves, and a lost
 * device has to rebuild the scene the way a lost WebGL context does.
 */
describe("useThreeScene — a WebGPU renderer", () => {
  function webgpuThree() {
    const base = fakeThree([]);
    let finishInit: () => void = () => {};
    let loseDevice: () => void = () => {};
    const renderer = () => {
      const r = base.renderer();
      const lost = new Promise<{ reason?: string }>((settle) => {
        loseDevice = () => settle({ reason: "unknown" });
      });
      return Object.assign(r, {
        init: () =>
          new Promise<void>((done) => {
            finishInit = done;
          }),
        backend: { isWebGPUBackend: true, device: { lost } },
      });
    };
    return { renderer, renderers: base.renderers, finishInit: () => finishInit(), loseDevice: () => loseDevice() };
  }

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("draws nothing until the device is ready", async () => {
    const gpu = webgpuThree();
    await mountScene({ renderer: gpu.renderer });
    await open();
    await advance(2);
    expect(gpu.renderers[0].draws).toBe(0);

    gpu.finishInit();
    await flush();
    await advance(2);
    expect(gpu.renderers[0].draws).toBeGreaterThan(0);
  });

  it("rebuilds when the device is lost", async () => {
    const gpu = webgpuThree();
    const { health } = await mountScene({ renderer: gpu.renderer });
    await open();
    gpu.finishInit();
    await flush();
    await advance(2);

    gpu.loseDevice();
    await flush();
    expect(health.state.generation).toBe(1);
    await advance(2);
    expect(gpu.renderers).toHaveLength(2);
  });
});
