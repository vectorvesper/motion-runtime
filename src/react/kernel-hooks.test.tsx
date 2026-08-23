// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { StrictMode } from "react";
import { render, cleanup, act } from "@testing-library/react";

/**
 * The kernel-adjacent React adapters: useSensorBus, useAnimationBudget,
 * useAdaptiveQuality, useMagneticIntent.
 *
 * These are thin wrappers whose whole job is lifecycle, so that is what is
 * tested — subscribe on mount, let go on unmount, and survive the StrictMode
 * double invoke. rAF is stubbed and hand-cranked as elsewhere.
 */

let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafId = 0;
let now = 0;

function crank(timeMs: number): void {
  now = timeMs;
  const pending = [...rafCallbacks.values()];
  rafCallbacks = new Map();
  for (const cb of pending) cb(timeMs);
}

/** matchMedia is not implemented in jsdom; hooks that gate on it need one. */
function stubMatchMedia(matches: Record<string, boolean>): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches[query] ?? false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function finePointerNoReducedMotion(): void {
  stubMatchMedia({
    "(any-pointer: fine)": true,
    "(prefers-reduced-motion: reduce)": false,
  });
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSensorBus", () => {
  it("starts the sensors while mounted and lets go on unmount", async () => {
    vi.resetModules();
    const { useSensorBus } = await import("./useSensorBus");
    const { getConductor } = await import("../core/conductor");

    function Consumer() {
      useSensorBus();
      return null;
    }

    const view = render(<Consumer />);
    expect(getConductor().getStats().subscribers).toHaveLength(1);

    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });

  it("keeps the sensors up while any consumer is still mounted", async () => {
    vi.resetModules();
    const { useSensorBus } = await import("./useSensorBus");
    const { getConductor } = await import("../core/conductor");

    function Consumer() {
      useSensorBus();
      return null;
    }

    const a = render(<Consumer />);
    const b = render(<Consumer />);
    // Ref-counted, so one set of listeners serves both.
    expect(getConductor().getStats().subscribers).toHaveLength(1);

    a.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(1);
    b.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });

  it("survives the StrictMode double mount without leaking a retain", async () => {
    vi.resetModules();
    const { useSensorBus } = await import("./useSensorBus");
    const { getConductor } = await import("../core/conductor");

    function Consumer() {
      useSensorBus();
      return null;
    }

    const view = render(
      <StrictMode>
        <Consumer />
      </StrictMode>,
    );
    expect(getConductor().getStats().subscribers).toHaveLength(1);

    // A leaked retain leaves the sensors running with nothing consuming them,
    // which stays invisible until something profiles the loop.
    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});

describe("useAnimationBudget", () => {
  it("reports a healthy tier before any frame has been measured", async () => {
    vi.resetModules();
    const { useAnimationBudget } = await import("./useAnimationBudget");

    let seen: { tier: number; label: string } | null = null;
    function Consumer() {
      const state = useAnimationBudget();
      seen = { tier: state.tier, label: state.label };
      return null;
    }

    render(<Consumer />);
    // Assuming the worst before measuring would degrade every page on load.
    expect(seen).toEqual({ tier: 0, label: "high" });
  });

  it("stops measuring once the last consumer unmounts", async () => {
    vi.resetModules();
    const { useAnimationBudget } = await import("./useAnimationBudget");
    const { getConductor } = await import("../core/conductor");

    function Consumer() {
      useAnimationBudget();
      return null;
    }

    const view = render(<Consumer />);
    expect(getConductor().getStats().subscribers.length).toBeGreaterThan(0);

    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});

describe("useAdaptiveQuality", () => {
  it("delivers the device verdict on mount, without waiting for frames", async () => {
    stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });
    vi.resetModules();
    const { useAdaptiveQuality } = await import("./useAdaptiveQuality");

    let seen: { tier: number; reasons: string[] } | null = null;
    function Consumer() {
      const state = useAdaptiveQuality();
      seen = { tier: state.tier, reasons: state.reasons };
      return null;
    }

    render(<Consumer />);

    // The whole point of the device floor is that the budget is blind for the
    // first seconds. If this arrived only once frames had degraded, a weak
    // device would render the expensive path for exactly as long as it takes
    // to hurt. jsdom has no WebGL2, so the floor here is the bottom tier.
    expect(seen!.tier).toBe(2);
    expect(seen!.reasons).toContain("no WebGL2");
  });

  it("passes the reduced-motion preference straight through", async () => {
    stubMatchMedia({ "(prefers-reduced-motion: reduce)": true });
    vi.resetModules();
    const { useAdaptiveQuality } = await import("./useAdaptiveQuality");

    let reducedMotion = false;
    function Consumer() {
      reducedMotion = useAdaptiveQuality().reducedMotion;
      return null;
    }

    render(<Consumer />);
    expect(reducedMotion).toBe(true);
  });

  it("unsubscribes on unmount", async () => {
    stubMatchMedia({ "(prefers-reduced-motion: reduce)": false });
    vi.resetModules();
    const { useAdaptiveQuality } = await import("./useAdaptiveQuality");
    const { getConductor } = await import("../core/conductor");

    function Consumer() {
      useAdaptiveQuality();
      return null;
    }

    const view = render(<Consumer />);
    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});

describe("useMagneticIntent", () => {
  it("stays inactive when there is no fine pointer", async () => {
    stubMatchMedia({ "(any-pointer: fine)": false });
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");

    let active = true;
    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      active = magnetic.active;
      return <button ref={magnetic.ref}>Get started</button>;
    }

    render(<Target />);
    act(() => crank(16));
    // Touch only: the element has to behave like an ordinary button.
    expect(active).toBe(false);
  });

  it("stays inactive under reduced motion", async () => {
    stubMatchMedia({
      "(any-pointer: fine)": true,
      "(prefers-reduced-motion: reduce)": true,
    });
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");

    let active = true;
    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      active = magnetic.active;
      return <button ref={magnetic.ref}>Get started</button>;
    }

    render(<Target />);
    act(() => crank(16));
    // This hook IS the motion, so it fails open to a normal element.
    expect(active).toBe(false);
  });

  it("activates with a fine pointer and no reduced-motion preference", async () => {
    finePointerNoReducedMotion();
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");

    let active = false;
    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      active = magnetic.active;
      return <button ref={magnetic.ref}>Get started</button>;
    }

    render(<Target />);
    act(() => crank(16));
    expect(active).toBe(true);
  });

  it("hands the transform back exactly as it found it", async () => {
    finePointerNoReducedMotion();
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");

    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      return (
        <button ref={magnetic.ref} style={{ transform: "rotate(45deg)" }}>
          Get started
        </button>
      );
    }

    const view = render(<Target />);
    const el = view.container.querySelector("button") as HTMLButtonElement;
    act(() => crank(16));

    // The hook owns transform while mounted, so a page that set its own
    // has to get it back untouched.
    view.unmount();
    expect(el.style.transform).toBe("rotate(45deg)");
  });

  it("releases its frame subscription on unmount", async () => {
    finePointerNoReducedMotion();
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");
    const { getConductor } = await import("../core/conductor");

    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      return <button ref={magnetic.ref}>Get started</button>;
    }

    const view = render(<Target />);
    act(() => crank(16));
    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});
