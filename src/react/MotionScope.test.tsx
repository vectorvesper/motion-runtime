// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, act } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";

/**
 * MotionScope and useMotionFrame.
 *
 * The conductor is a module singleton driven by rAF, so each test imports a
 * fresh copy (vi.resetModules) with rAF stubbed and hand-cranked — the same
 * pattern the core conductor tests use.
 */

let rafCallback: FrameRequestCallback | null = null;
let rafId = 0;
let now = 0;

function crank(timeMs: number): void {
  now = timeMs;
  const cb = rafCallback;
  rafCallback = null;
  cb?.(timeMs);
}

async function freshModule() {
  vi.resetModules();
  const scope = await import("./MotionScope");
  const core = await import("../entry.core");
  return { ...scope, getConductor: core.getConductor };
}

beforeEach(() => {
  rafCallback = null;
  rafId = 0;
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallback = cb;
    return ++rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("performance", { now: () => now });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useMotionFrame", () => {
  it("subscribes on mount and unsubscribes on unmount", async () => {
    const { useMotionFrame, getConductor } = await freshModule();
    const spy = vi.fn();

    function Ticker() {
      useMotionFrame("render", spy);
      return null;
    }

    const view = render(<Ticker />);
    act(() => crank(16));
    expect(spy).toHaveBeenCalledTimes(1);

    view.unmount();
    act(() => crank(32));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });

  it("does not subscribe while enabled is false", async () => {
    const { useMotionFrame } = await freshModule();
    const spy = vi.fn();

    function Ticker({ on }: { on: boolean }) {
      useMotionFrame("render", spy, { enabled: on });
      return null;
    }

    const view = render(<Ticker on={false} />);
    act(() => crank(16));
    expect(spy).not.toHaveBeenCalled();

    view.rerender(<Ticker on={true} />);
    act(() => crank(32));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps one subscription when only the callback identity changes", async () => {
    const { useMotionFrame, getConductor } = await freshModule();

    function Ticker({ value }: { value: number }) {
      // New closure every render — the hook holds it in a ref instead of
      // resubscribing, which would churn the lane and reset the cost average.
      useMotionFrame("render", () => void value);
      return null;
    }

    const view = render(<Ticker value={1} />);
    const first = getConductor().getStats().subscribers.length;
    view.rerender(<Ticker value={2} />);
    view.rerender(<Ticker value={3} />);

    expect(getConductor().getStats().subscribers).toHaveLength(first);
    expect(first).toBe(1);
  });

  it("calls the latest callback, not the one from the first render", async () => {
    const { useMotionFrame } = await freshModule();
    const seen: number[] = [];

    function Ticker({ value }: { value: number }) {
      useMotionFrame("render", () => seen.push(value));
      return null;
    }

    const view = render(<Ticker value={1} />);
    act(() => crank(16));
    view.rerender(<Ticker value={2} />);
    act(() => crank(32));

    expect(seen).toEqual([1, 2]);
  });

  it("inherits the scope from the nearest provider", async () => {
    const { MotionScope, useMotionFrame, getConductor } = await freshModule();

    function Ticker() {
      useMotionFrame("render", () => {});
      return null;
    }

    render(
      <MotionScope name="gallery">
        <Ticker />
      </MotionScope>,
    );
    act(() => crank(16));

    const sub = getConductor().getStats().subscribers[0];
    expect(sub).toBeDefined();
  });
});

describe("MotionScope lease", () => {
  it("takes the lease on pointer down and gives it back on pointer up", async () => {
    const { MotionScope, getConductor } = await freshModule();

    const { container } = render(
      <MotionScope name="gallery">
        <button>drag me</button>
      </MotionScope>,
    );
    const region = container.firstElementChild as HTMLElement;

    expect(getConductor().getStats().activeScope).toBeNull();
    fireEvent.pointerDown(region);
    expect(getConductor().getStats().activeScope).toBe("gallery");
    fireEvent.pointerUp(region);
    expect(getConductor().getStats().activeScope).toBeNull();
  });

  it("releases the lease if the region unmounts mid-drag", async () => {
    const { MotionScope, getConductor } = await freshModule();

    const view = render(
      <MotionScope name="gallery">
        <button>drag me</button>
      </MotionScope>,
    );
    const region = view.container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(region);
    expect(getConductor().getStats().activeScope).toBe("gallery");
    view.unmount();
    expect(getConductor().getStats().activeScope).toBeNull();
  });

  it("does not take the lease when claimOnPointer is off", async () => {
    const { MotionScope, getConductor } = await freshModule();

    const { container } = render(
      <MotionScope name="gallery" claimOnPointer={false}>
        <button>drag me</button>
      </MotionScope>,
    );
    fireEvent.pointerDown(container.firstElementChild as HTMLElement);
    expect(getConductor().getStats().activeScope).toBeNull();
  });
});

describe("MotionScope lease — drags that leave, multi-touch, and stopPropagation", () => {
  it("keeps the lease when the pointer leaves the region mid-drag", async () => {
    const { MotionScope, getConductor } = await freshModule();

    const { container } = render(
      <MotionScope name="gallery">
        <button>drag me</button>
      </MotionScope>,
    );
    const region = container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(region, { pointerId: 1 });
    expect(getConductor().getStats().activeScope).toBe("gallery");

    // A drag that travels outside the region is still a drag. Releasing here
    // demotes the gallery at the exact moment the user is dragging it.
    //
    // Fired as pointerout with an outside relatedTarget, because that is what
    // React synthesises onPointerLeave from. A plain pointerleave event never
    // reaches the handler, so asserting against one passes for the wrong reason.
    fireEvent.pointerOut(region, { pointerId: 1, relatedTarget: document.body });
    expect(getConductor().getStats().activeScope).toBe("gallery");

    fireEvent.pointerUp(region, { pointerId: 1 });
    expect(getConductor().getStats().activeScope).toBeNull();
  });

  it("holds the lease until the last pointer lifts", async () => {
    const { MotionScope, getConductor } = await freshModule();

    const { container } = render(
      <MotionScope name="gallery">
        <button>drag me</button>
      </MotionScope>,
    );
    const region = container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(region, { pointerId: 1 });
    fireEvent.pointerDown(region, { pointerId: 2 });
    expect(getConductor().getStats().activeScope).toBe("gallery");

    // Second finger up. The first is still down, so this is still a drag.
    fireEvent.pointerUp(region, { pointerId: 2 });
    expect(getConductor().getStats().activeScope).toBe("gallery");

    fireEvent.pointerUp(region, { pointerId: 1 });
    expect(getConductor().getStats().activeScope).toBeNull();
  });

  it("takes the lease even when a child stops pointerdown from bubbling", async () => {
    const { MotionScope, getConductor } = await freshModule();

    // Drag implementations routinely do this so an outer handler does not also
    // react to the press. It must not silently disable the scope.
    function Draggable() {
      return (
        <button onPointerDown={(e) => e.stopPropagation()}>drag me</button>
      );
    }

    const { getByText } = render(
      <MotionScope name="gallery">
        <Draggable />
      </MotionScope>,
    );

    fireEvent.pointerDown(getByText("drag me"), { pointerId: 1 });
    expect(getConductor().getStats().activeScope).toBe("gallery");
  });
});
