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
 * Returns a {@link BudgetState} snapshot that updates on tier changes and on
 * a slow ~2 Hz heartbeat (useful for HUD `avgFrameMs` displays).
 *
 * ### Tier contract
 * | tier | label    | meaning                                     |
 * |------|----------|---------------------------------------------|
 * | `0`  | `"high"`  | Frames are healthy — run the full look      |
 * | `1`  | `"medium"`| Sustained drops below ~54 fps — shed extras |
 * | `2`  | `"low"`   | Sustained drops below ~30 fps — survival    |
 *
 * ### Why React state
 * Tier changes are hysteresis-gated (fast to degrade, 8 s to recover), so
 * they are rare. Using React state here is intentional: conditional rendering
 * of expensive effects is exactly the right consumption pattern. Do **not**
 * read this inside a `requestAnimationFrame` loop — poll `getAnimationBudget().state`
 * there instead.
 *
 * ### Usage patterns
 *
 * **1. Gate an expensive layer**
 * ```tsx
 * const { tier } = useAnimationBudget();
 * {tier === 0 && <ChromaticAberrationCanvas />}
 * ```
 *
 * **2. Conditional CSS class**
 * ```tsx
 * const { tier } = useAnimationBudget();
 * <div className={tier < 2 ? "backdrop-blur-xl" : "bg-neutral-900"} />
 * ```
 *
 * **3. Live telemetry HUD**
 * ```tsx
 * const { avgFrameMs, slowRatio, label } = useAnimationBudget();
 * <span>{avgFrameMs.toFixed(1)} ms · {label}</span>
 * ```
 *
 * @returns The current {@link BudgetState} — stable reference until the next
 *   tier change or heartbeat tick.
 */
export function useAnimationBudget(): BudgetState {
  const [state, setState] = useState<BudgetState>(INITIAL);
  useEffect(() => getAnimationBudget().subscribe(setState), []);
  return state;
}
