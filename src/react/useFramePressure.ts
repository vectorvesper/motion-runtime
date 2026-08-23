"use client";

import { useEffect, useState } from "react";
import {
  getFramePressure,
  type PressureState,
} from "../core/frame-pressure/FramePressure";

const INITIAL: PressureState = {
  source: "none",
  confidence: 1,
  frameMs: 0,
  runtimeMs: 0,
  mainOtherMs: null,
  offThreadMs: 0,
  budgetMs: 1000 / 60,
  longTasks: 0,
};

/**
 * What is currently eating the frame, and how sure the runtime is about it.
 *
 * ```tsx
 * const { source, confidence } = useFramePressure();
 *
 * // Only reduce the scene when rendering is what is actually slow.
 * const dpr = source === "render" && confidence > 0.5 ? 1 : 2;
 * ```
 *
 * Verdicts change slowly and are emitted at most twice a second, so React
 * state is the right shape here. Do not read it inside a frame callback —
 * use `getFramePressure().state` there.
 *
 * Read the meaning of each `source` on {@link PressureState}. The short
 * version: `"runtime"` means shedding our own work will help, `"main-thread"`
 * means delay mounts rather than dropping quality, `"render"` means lower the
 * quality, and `"unknown"` means change nothing.
 *
 * Nothing in the runtime acts on this yet. It reports so that it can be
 * checked against real pages before it is allowed to make decisions.
 */
export function useFramePressure(): PressureState {
  const [state, setState] = useState<PressureState>(INITIAL);
  useEffect(() => getFramePressure().subscribe(setState), []);
  return state;
}
