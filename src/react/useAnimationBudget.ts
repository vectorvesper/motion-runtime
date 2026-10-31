"use client";

import { useEffect, useState } from "react";
import {
  getAnimationBudget,
  type BudgetState,
} from "../core/animation-budget/AnimationBudget";

const INITIAL: BudgetState = {
  tier: 0,
  label: "high",
  avgFrameMs: 0,
  slowRatio: 0,
  headroom: 1000 / 60,
  workMs: 0,
  frameBudgetMs: 1000 / 60,
};

/**
 * Subscribe to the frame-headroom governor.
 *
 * Returns a {@link BudgetState} snapshot that updates on tier changes and on a
 * heartbeat of about 2Hz.
 *
 * | tier | label     | meaning                                     |
 * |------|-----------|---------------------------------------------|
 * | `0`  | `"high"`  | Frames are healthy, run the full look       |
 * | `1`  | `"medium"`| Sustained drops below ~54 fps, shed extras  |
 * | `2`  | `"low"`   | Sustained drops below ~30 fps, survival     |
 *
 * Tier changes are rare, so React state suits conditional rendering of
 * expensive effects. Don't read this inside a `requestAnimationFrame` loop: poll
 * `getAnimationBudget().state` there.
 *
 * ```tsx
 * const { tier } = useAnimationBudget();
 * {tier === 0 && <ChromaticAberrationCanvas />}
 * ```
 *
 * @returns The current {@link BudgetState}, a stable reference until the next
 *   tier change or heartbeat tick.
 */
export function useAnimationBudget(): BudgetState {
  const [state, setState] = useState<BudgetState>(INITIAL);
  useEffect(() => getAnimationBudget().subscribe(setState), []);
  return state;
}
