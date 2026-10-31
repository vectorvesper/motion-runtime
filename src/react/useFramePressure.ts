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
  unattributedMs: 0,
  budgetMs: 1000 / 60,
  longTasks: 0,
};

/**
 * What is eating the frame, and how sure the runtime is.
 *
 * ```tsx
 * const { source, confidence } = useFramePressure();
 *
 * // Only reduce the scene when rendering is what is slow.
 * const dpr = source === "render" && confidence > 0.5 ? 1 : 2;
 * ```
 *
 * Verdicts are emitted at most twice a second, so React state fits. Inside a
 * frame callback use `getFramePressure().state`.
 *
 * See {@link PressureState} for each `source`. In short: `"runtime"` means
 * shedding our own work will help, `"main-thread"` means delay mounts and keep
 * quality, `"render"` means lower the quality, and `"unknown"` means change
 * nothing.
 */
export function useFramePressure(): PressureState {
  const [state, setState] = useState<PressureState>(INITIAL);
  useEffect(() => getFramePressure().subscribe(setState), []);
  return state;
}
