"use client";

import { useEffect, useState } from "react";
import { getConductor } from "../core/conductor";
import { getAnimationBudget } from "../core/animation-budget/AnimationBudget";

/**
 * How expensive the thing you are about to mount is.
 *
 * The heavier it is, the more free frame time the page has to show before it
 * is worth starting. Shared by {@link useSafeToMount} and `useSceneGate`.
 */
export type MountCost = "light" | "normal" | "heavy";

/**
 * The thresholds each cost maps to.
 *
 * These replaced three separate numbers — minimum headroom, consecutive clean
 * frames, and a CPU core floor. Every one of them was a question a developer
 * had no way to answer, and the catalogue proved it: of ten call sites, six
 * passed the identical override and four passed nothing. That is not tuning,
 * it is people working around a default. "How expensive is this?" is a
 * question the person writing the component can actually answer.
 */
export interface MountCostThresholds {
  /** Spare frame time a frame must show to count as clean, in ms. */
  readonly headroomMs: number;
  /** How many clean frames in a row before the gate opens. */
  readonly cleanFrames: number;
  /** Below this core count the gate never opens. */
  readonly minCores: number;
}

/**
 * What each cost resolves to. Frozen, and readable for the same reason
 * `POINTER_INTENT_SENSITIVITY` is: a devtools panel or a docs demo
 * explaining why a gate is still closed needs the actual numbers, and the
 * alternative is every such surface keeping a copy that drifts.
 */
export const SAFE_TO_MOUNT_COST: Readonly<Record<MountCost, MountCostThresholds>> =
  Object.freeze({
    light: Object.freeze({ headroomMs: 1, cleanFrames: 1, minCores: 2 }),
    normal: Object.freeze({ headroomMs: 2, cleanFrames: 2, minCores: 4 }),
    heavy: Object.freeze({ headroomMs: 6, cleanFrames: 3, minCores: 4 }),
  });

const COST = SAFE_TO_MOUNT_COST;

export interface UseSafeToMountOptions {
  /**
   * How expensive the thing being mounted is. Default `"normal"`.
   *
   * - `"light"` — a small canvas, a handful of animated elements
   * - `"normal"` — most components
   * - `"heavy"` — a full 3D scene, post-processing, a large particle system
   */
  cost?: MountCost;
}

/**
 * How long something may wait for headroom before it mounts anyway, in ms.
 *
 * Waiting for a free moment is the point of the gate, but waiting forever is a
 * blank space where the scene should be. Two ways it happened: a battery saver
 * holding the page at 30fps, which read as a page missing every frame (RB-1,
 * now recognised by presentation-cap.ts), and a busy landing page that never
 * shows three quiet frames in a row for a `heavy` scene. This is the net under
 * both, and under whatever else turns out to keep the gate shut.
 *
 * Internal. Not a public option: the value comes from lab measurements of how
 * long healthy pages actually wait. Across 251 vv-lab runs since the
 * 2026-09-13 fixes (Chrome, WebKit and the iPhone profile), the slowest first
 * draw on a healthy page was 1.4s from arriving, and a page held at 30fps took
 * 1.6s once the cap was recognised. Five seconds sits well clear of both, so it
 * only ever fires on a gate that really was not going to open.
 */
export const MAX_MOUNT_WAIT_MS = 5000;

/** Is this device below the core floor for this cost? */
function belowCoreFloor(cost: MountCost): boolean {
  if (typeof navigator === "undefined") return false;
  const cores = navigator.hardwareConcurrency;
  return Boolean(cores && cores < COST[cost].minCores);
}

/**
 * Returns `true` once the page has enough spare frame time to absorb an
 * expensive mount.
 *
 * ```tsx
 * const ready = useSafeToMount({ cost: "heavy" });
 * return ready ? <Scene /> : <Poster />;
 * ```
 *
 * It starts `false` and only ever flips to `true`. Something that unmounted
 * itself the moment it made the page slow would oscillate forever, so the gate
 * is one-way.
 *
 * It does not wait forever. If no free moment has arrived a few seconds after
 * the hook mounts, it opens anyway, and the quality governor decides how much
 * the mounted thing should draw.
 *
 * On a machine with too few CPU cores for the given cost it stays `false` and
 * stops watching. Cores cannot improve while the page is open, so that is the
 * one condition that ends the story early.
 */
export function useSafeToMount({
  cost = "normal",
}: UseSafeToMountOptions = {}): boolean {
  return useHeadroom(cost, true);
}

/**
 * The gate behind useSafeToMount, with the wait clock exposed.
 *
 * Internal. `waiting` says when the clock may run. useSafeToMount runs it from
 * mount. useSceneGate runs it only while its element is near the viewport and
 * not yet started, so a scene far down the page cannot time out unseen and
 * then mount the instant it scrolls into view, mid-scroll and with no headroom
 * check at all.
 */
export function useHeadroom(cost: MountCost, waiting: boolean): boolean {
  const [safe, setSafe] = useState(false);
  const [waitedOut, setWaitedOut] = useState(false);
  const open = safe || waitedOut;

  useEffect(() => {
    if (!waiting || open || belowCoreFloor(cost)) return;
    const id = setTimeout(() => setWaitedOut(true), MAX_MOUNT_WAIT_MS);
    return () => clearTimeout(id);
  }, [waiting, open, cost]);

  useEffect(() => {
    // Opened either way: nothing left to watch for.
    if (open) return;
    const { headroomMs, cleanFrames: required } = COST[cost];

    // Static hardware floor. Unlike the frame signals this can never improve,
    // so it is the one condition that legitimately ends the story early.
    if (belowCoreFloor(cost)) return;

    const budget = getAnimationBudget();
    // Hold the governor open for as long as we're watching. It only measures
    // while something is subscribed, and polling a governor that isn't running
    // would read a frozen snapshot forever.
    const releaseBudget = budget.subscribe(() => {});

    let clean = 0;
    let settled = false;

    // Poll per frame rather than per budget emit: the budget only emits on
    // tier changes and a 2Hz heartbeat, which would quietly turn a two-frame
    // requirement into "wait a second".
    //
    // There is deliberately no "already healthy, open immediately" shortcut.
    // It would have to run inside this effect, which means a synchronous
    // setState and a cascading render, and it cannot move into render without
    // breaking hydration — the server has no frame timings, so the first
    // client render must agree with it and start `false`.
    //
    // History worth keeping: the first version gave up permanently if the
    // budget happened to be degraded at mount. That is exactly backwards, since
    // a page is always busy during hydration, which is precisely when this
    // hook mounts. It also relied on a `headroom` figure derived from the
    // vsync-pinned frame interval, so a healthy 60Hz page reported ~0ms and no
    // threshold above zero was reachable at all.
    const off = getConductor().subscribe(
      "input",
      () => {
        if (settled) return;
        const { tier, headroom } = budget.state;
        if (tier === 0 && headroom >= headroomMs) {
          clean++;
          if (clean >= required) {
            settled = true;
            setSafe(true);
          }
        } else {
          clean = 0;
        }
      },
      // Subscribed after the governor's own essential measure pass, so it
      // reads the state produced by this very frame.
      { priority: "essential", label: "useSafeToMount" },
    );

    return () => {
      off();
      releaseBudget();
    };
  }, [cost, open]);

  return open;
}
