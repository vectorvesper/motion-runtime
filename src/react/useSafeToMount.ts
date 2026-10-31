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
 * The thresholds each cost maps to. `cost` asks the one question the person
 * writing a component can answer: how expensive is this?
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
 * What each cost resolves to. Frozen, and readable so a devtools panel or docs
 * demo can show the actual numbers instead of keeping a copy.
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
   * - `"light"`: a small canvas, a handful of animated elements
   * - `"normal"`: most components
   * - `"heavy"`: a full 3D scene, post-processing, a large particle system
   */
  cost?: MountCost;
}

/**
 * How long something may wait for headroom before it mounts anyway, in ms.
 *
 * Waiting forever is a blank space where the scene should be, and a busy
 * landing page may never show three quiet frames in a row for a `heavy` scene.
 *
 * Internal. The slowest first draw measured on a healthy page was 1.4s, and a
 * page held at 30fps took 1.6s once the cap was recognised, so five seconds
 * only fires on a gate that wasn't going to open.
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
 * It starts `false` and only flips to `true`: something that unmounted itself
 * when it made the page slow would oscillate forever.
 *
 * If no free moment arrives a few seconds after the hook mounts, it opens
 * anyway and the quality governor decides how much the mounted thing draws.
 *
 * On a machine with too few CPU cores for the given cost it stays `false` and
 * stops watching, because cores can't improve while the page is open.
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
 * not yet started, so a scene far down the page can't time out unseen and then
 * mount mid-scroll with no headroom check.
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

    // Static hardware floor. Unlike the frame signals this can never improve.
    if (belowCoreFloor(cost)) return;

    const budget = getAnimationBudget();
    // Hold the governor open for as long as we're watching. It only measures
    // while something is subscribed, and polling a governor that isn't running
    // would read a frozen snapshot forever.
    const releaseBudget = budget.subscribe(() => {});

    let clean = 0;
    let settled = false;

    // Poll per frame: the budget only emits on tier changes and at 2Hz,
    // which would turn a two-frame requirement into a one-second wait.
    //
    // There is no "already healthy, open immediately" shortcut. Inside this
    // effect it would be a synchronous setState and a cascading render, and in
    // render it would break hydration: the server has no frame timings, so the
    // first client render has to start `false` too.
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
