"use client";

import { useEffect, useState } from "react";
import { getConductor } from "../core/conductor";
import { getAnimationBudget } from "../core/animation-budget/AnimationBudget";

/**
 * Options for `useSafeToMount`.
 */
export interface UseSafeToMountOptions {
  /**
   * Minimum free time required in every qualifying frame, in milliseconds.
   * Measured against the detected display rate — at 60Hz the whole frame is
   * 16.6ms, so a value of `6` asks for roughly a third of it to still be
   * unspoken for.
   * @default 6
   */
  minHeadroomMs?: number;
  /**
   * Number of consecutive clean frames (above `minHeadroomMs`) required
   * before returning `true`.
   * @default 3
   */
  requiredCleanFrames?: number;
  /**
   * Minimum hardware concurrency (CPU logical cores) required to allow mounting.
   * Direct hardware-level block to skip telemetry checks entirely on very weak
   * devices. This one is permanent — cores do not improve while the page is open.
   * @default 4
   */
  minCores?: number;
}

/**
 * Returns `true` only once the frame loop has sustained enough headroom to
 * safely absorb a new expensive mount.
 *
 * Once `true`, the value **never returns to `false`** within the same mount
 * lifecycle — an expensive component that unmounted itself the moment it made
 * the page slow would oscillate forever.
 *
 * ### Fixed in v0.2
 *
 * v0.1 gave up permanently if the budget happened to be at tier 1 or worse at
 * the moment the hook mounted — it never subscribed, so it could not reopen
 * without a full remount. That is exactly backwards for the common case: a
 * page is *always* busy during hydration, which is precisely when this hook
 * mounts. It now waits, and opens the gate when the page actually settles.
 *
 * It also relies on the corrected `headroom` signal. In v0.1 that number was
 * derived from the vsync-pinned frame interval, so a healthy 60Hz page
 * reported ~0ms and the default `minHeadroomMs: 6` was unreachable.
 */
export function useSafeToMount({
  minHeadroomMs = 6,
  requiredCleanFrames = 3,
  minCores = 4,
}: UseSafeToMountOptions = {}): boolean {
  const [safe, setSafe] = useState(false);

  useEffect(() => {
    // Static hardware floor. Unlike the frame signals this can never improve,
    // so it is the one condition that legitimately ends the story early.
    if (typeof navigator !== "undefined") {
      const cores = navigator.hardwareConcurrency;
      if (cores && cores < minCores) return;
    }

    const budget = getAnimationBudget();
    // Hold the governor open for as long as we're watching. It only measures
    // while something is subscribed, and polling a governor that isn't
    // running would read a frozen snapshot forever.
    const releaseBudget = budget.subscribe(() => {});

    let cleanFrames = 0;
    let settled = false;

    // Poll per frame rather than per budget emit: the budget only emits on
    // tier changes and a 2Hz heartbeat, which would quietly turn
    // `requiredCleanFrames: 3` into "wait a second and a half".
    //
    // There is deliberately no "already healthy, open immediately" shortcut.
    // It would have to run inside this effect, which means a synchronous
    // setState and a cascading render, and it cannot move into render without
    // breaking hydration — the server has no frame timings, so the first
    // client render must agree with it and start `false`. Waiting the same
    // three frames on every page costs ~50ms before an expensive mount, which
    // is a fine price for one code path instead of two.
    const off = getConductor().subscribe(
      "input",
      () => {
        if (settled) return;
        const { tier, headroom } = budget.state;
        if (tier === 0 && headroom >= minHeadroomMs) {
          cleanFrames++;
          if (cleanFrames >= requiredCleanFrames) {
            settled = true;
            setSafe(true);
          }
        } else {
          cleanFrames = 0;
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
  }, [minHeadroomMs, requiredCleanFrames, minCores]);

  return safe;
}
