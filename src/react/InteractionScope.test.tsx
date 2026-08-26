// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useRef } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";

/**
 * InteractionScope and useTick.
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
  const scope = await import("./InteractionScope");
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

describe("useTick", () => {
  it("subscribes on mount and unsubscribes on unmount", async () => {
    const { useTick, getConductor } = await freshModule();
    const spy = vi.fn();

    function Ticker() {
      useTick("render", spy);
      return null;
    }

    const view = render(<Ticker />);
    act(() => crank(16));
    expect(spy).toHaveBeenCalledTimes(1);

    view.unmount();
    act(() => crank(32));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("does not subscribe while enabled is false", async () => {
    const { useTick } = await freshModule();
    const spy = vi.fn();

    function Ticker({ on }: { on: boolean }) {
      useTick("render", spy, { enabled: on });
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
    const { useTick, getConductor } = await freshModule();

    function Ticker({ value }: { value: number }) {
      // New closure every render. The hook holds it in a ref instead of
      // resubscribing, which would churn the lane and reset the cost average.
      useTick("render", () => void value);
      return null;
    }

    const view = render(<Ticker value={1} />);
    view.rerender(<Ticker value={2} />);
    view.rerender(<Ticker value={3} />);

    expect(getConductor().state.subscribers).toHaveLength(1);
  });

  it("calls the latest callback, not the one from the first render", async () => {
    const { useTick } = await freshModule();
    const seen: number[] = [];

    function Ticker({ value }: { value: number }) {
      useTick("render", () => seen.push(value));
      return null;
    }

    const view = render(<Ticker value={1} />);
    act(() => crank(16));
    view.rerender(<Ticker value={2} />);
    act(() => crank(32));

    expect(seen).toEqual([1, 2]);
  });

  it("joins the surrounding region", async () => {
    const { InteractionScope, useTick, getConductor } = await freshModule();

    function Ticker() {
      useTick("render", () => {});
      return null;
    }

    render(
      <InteractionScope>
        <Ticker />
      </InteractionScope>,
    );
    act(() => crank(16));

    const sub = getConductor().state.subscribers[0];
    expect(sub).toBeDefined();
  });

  it("stays background inside a region when asked", async () => {
    const { InteractionScope, useTick, getConductor } = await freshModule();

    function Ambient() {
      // An ambient layer behind a gallery should yield like anything else
      // while the gallery is being dragged.
      useTick("render", () => {}, { background: true, label: "ambient" });
      return null;
    }
    function Gallery() {
      useTick("render", () => {}, { label: "gallery" });
      return null;
    }

    const { container } = render(
      <InteractionScope>
        <Ambient />
        <Gallery />
        <button>drag me</button>
      </InteractionScope>,
    );
    act(() => crank(16));
    fireEvent.pointerDown(container.firstElementChild as HTMLElement, {
      pointerId: 1,
    });

    const stats = getConductor().state;
    const byLabel = Object.fromEntries(
      stats.subscribers.map((s) => [s.label, s.scope]),
    );

    // Both are rendered inside the region. Only the one that did not opt out
    // is protected while the region is active.
    expect(stats.activeScope).not.toBeNull();
    expect(byLabel.gallery).toBe(stats.activeScope);
    expect(byLabel.ambient).toBeNull();
  });
});

describe("InteractionScope activation", () => {
  it("needs no props at all", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    // The common case is a bare wrapper. A page-unique name is work the
    // library does for you.
    const { container } = render(
      <InteractionScope>
        <button>drag me</button>
      </InteractionScope>,
    );
    const region = container.firstElementChild as HTMLElement;

    expect(getConductor().state.activeScope).toBeNull();
    fireEvent.pointerDown(region);
    expect(getConductor().state.activeScope).not.toBeNull();
    fireEvent.pointerUp(region);
    expect(getConductor().state.activeScope).toBeNull();
  });

  it("gives two regions different identities without being told", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    const { container } = render(
      <>
        <InteractionScope>
          <button>first</button>
        </InteractionScope>
        <InteractionScope>
          <button>second</button>
        </InteractionScope>
      </>,
    );
    const [a, b] = [...container.children] as HTMLElement[];

    fireEvent.pointerDown(a);
    const first = getConductor().state.activeScope;
    fireEvent.pointerUp(a);

    fireEvent.pointerDown(b);
    const second = getConductor().state.activeScope;
    fireEvent.pointerUp(b);

    // Two hand-written names that collided would silently share one claim.
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  it("reports the label for devtools, since the id is generated", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    const { container } = render(
      <InteractionScope label="Product gallery">
        <button>drag me</button>
      </InteractionScope>,
    );
    fireEvent.pointerDown(container.firstElementChild as HTMLElement);

    // A readout showing ":r1:" would be useless.
    expect(getConductor().state.activeScopeLabel).toBe("Product gallery");
  });

  it("releases if the region unmounts mid-drag", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    const view = render(
      <InteractionScope>
        <button>drag me</button>
      </InteractionScope>,
    );
    fireEvent.pointerDown(view.container.firstElementChild as HTMLElement);
    expect(getConductor().state.activeScope).not.toBeNull();

    view.unmount();
    expect(getConductor().state.activeScope).toBeNull();
  });
});

describe("InteractionScope controlled activation", () => {
  it("follows the active prop instead of pointer input", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    function Viewer({ on }: { on: boolean }) {
      return (
        <InteractionScope active={on} label="Camera">
          <button>camera</button>
        </InteractionScope>
      );
    }

    const view = render(<Viewer on={false} />);
    expect(getConductor().state.activeScope).toBeNull();

    view.rerender(<Viewer on={true} />);
    expect(getConductor().state.activeScope).not.toBeNull();
    expect(getConductor().state.activeScopeLabel).toBe("Camera");

    view.rerender(<Viewer on={false} />);
    expect(getConductor().state.activeScope).toBeNull();
  });

  it("ignores pointer input once active is being controlled", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    const { container } = render(
      <InteractionScope active={false}>
        <button>camera</button>
      </InteractionScope>,
    );

    fireEvent.pointerDown(container.firstElementChild as HTMLElement);
    // Two sources of truth for one claim would fight.
    expect(getConductor().state.activeScope).toBeNull();
  });

  it("releases on unmount while still active", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    const view = render(
      <InteractionScope active>
        <button>camera</button>
      </InteractionScope>,
    );
    expect(getConductor().state.activeScope).not.toBeNull();

    view.unmount();
    expect(getConductor().state.activeScope).toBeNull();
  });
});

describe("InteractionScope asChild", () => {
  it("renders no wrapper element", async () => {
    const { InteractionScope } = await freshModule();

    const { container } = render(
      <InteractionScope asChild>
        <section id="gallery">
          <button>drag me</button>
        </section>
      </InteractionScope>,
    );

    // An injected div can break a flex or grid parent.
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.id).toBe("gallery");
    expect(container.firstElementChild?.tagName).toBe("SECTION");
  });

  it("activates from the child element", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    const { container } = render(
      <InteractionScope asChild>
        <section>
          <button>drag me</button>
        </section>
      </InteractionScope>,
    );

    fireEvent.pointerDown(container.firstElementChild as HTMLElement);
    expect(getConductor().state.activeScope).not.toBeNull();
  });

  it("keeps a ref the child already had", async () => {
    const { InteractionScope } = await freshModule();

    let seen: HTMLElement | null = null;
    function Gallery() {
      const mine = useRef<HTMLElement | null>(null);
      React.useEffect(() => {
        seen = mine.current;
      });
      return (
        <InteractionScope asChild>
          <section ref={mine}>
            <button>drag me</button>
          </section>
        </InteractionScope>
      );
    }

    render(<Gallery />);
    // Swallowing the child's own ref would break the component using it.
    expect(seen).not.toBeNull();
    expect((seen as unknown as HTMLElement).tagName).toBe("SECTION");
  });
});

describe("InteractionScope — drags that leave, multi-touch, and stopPropagation", () => {
  it("stays active when the pointer leaves the region mid-drag", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    const { container } = render(
      <InteractionScope>
        <button>drag me</button>
      </InteractionScope>,
    );
    const region = container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(region, { pointerId: 1 });
    expect(getConductor().state.activeScope).not.toBeNull();

    // Fired as pointerout with an outside relatedTarget, because that is what
    // React synthesises onPointerLeave from. A plain pointerleave event never
    // reaches a handler, so asserting against one passes for the wrong reason.
    fireEvent.pointerOut(region, { pointerId: 1, relatedTarget: document.body });
    expect(getConductor().state.activeScope).not.toBeNull();

    fireEvent.pointerUp(region, { pointerId: 1 });
    expect(getConductor().state.activeScope).toBeNull();
  });

  it("stays active until the last pointer lifts", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    const { container } = render(
      <InteractionScope>
        <button>drag me</button>
      </InteractionScope>,
    );
    const region = container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(region, { pointerId: 1 });
    fireEvent.pointerDown(region, { pointerId: 2 });
    expect(getConductor().state.activeScope).not.toBeNull();

    fireEvent.pointerUp(region, { pointerId: 2 });
    expect(getConductor().state.activeScope).not.toBeNull();

    fireEvent.pointerUp(region, { pointerId: 1 });
    expect(getConductor().state.activeScope).toBeNull();
  });

  it("activates even when a child stops pointerdown from bubbling", async () => {
    const { InteractionScope, getConductor } = await freshModule();

    // Drag implementations routinely do this so an outer handler does not also
    // react to the press. It must not silently disable the region.
    function Draggable() {
      return <button onPointerDown={(e) => e.stopPropagation()}>drag me</button>;
    }

    const { getByText } = render(
      <InteractionScope>
        <Draggable />
      </InteractionScope>,
    );

    fireEvent.pointerDown(getByText("drag me"), { pointerId: 1 });
    expect(getConductor().state.activeScope).not.toBeNull();
  });
});

describe("InteractionScope — active as three named values", () => {
  it('accepts an explicit "pointer" and behaves exactly like omitting the prop', async () => {
    const { InteractionScope, getConductor } = await freshModule();
    // The point of the 3.0 shape. In 2.x, opting back into pointer activation
    // meant passing `undefined`, so an A/B toggle read
    // `active={on ? undefined : false}`. Now the on-state has a name.
    const view = render(
      <InteractionScope active="pointer" label="explicit">
        <div data-testid="region" />
      </InteractionScope>,
    );

    const region = view.getByTestId("region");
    expect(getConductor().state.activeScope).toBeNull();

    await act(async () => {
      fireEvent.pointerDown(region, { pointerId: 1 });
    });
    expect(getConductor().state.activeScope).not.toBeNull();

    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(getConductor().state.activeScope).toBeNull();
  });

  it("can be toggled between pointer-driven and off without passing undefined", async () => {
    const { InteractionScope, getConductor } = await freshModule();
    function Toggle({ on }: { on: boolean }) {
      return (
        <InteractionScope active={on ? "pointer" : false} label="ab">
          <div data-testid="region" />
        </InteractionScope>
      );
    }

    const view = render(<Toggle on={false} />);
    const region = view.getByTestId("region");

    await act(async () => {
      fireEvent.pointerDown(region, { pointerId: 2 });
    });
    expect(getConductor().state.activeScope).toBeNull();

    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 2 });
    });
    view.rerender(<Toggle on />);

    await act(async () => {
      fireEvent.pointerDown(region, { pointerId: 3 });
    });
    expect(getConductor().state.activeScope).not.toBeNull();

    await act(async () => {
      fireEvent.pointerUp(window, { pointerId: 3 });
    });
  });
});
