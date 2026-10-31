"use client";

import { useEffect, useState } from "react";
import {
  getAdaptiveQuality,
  type AdaptiveState,
} from "../core/adaptive-quality/AdaptiveQuality";

const INITIAL: AdaptiveState = {
  tier: 0,
  label: "high",
  deviceTier: 0,
  budgetTier: 0,
  cause: "ok",
  reasons: [],
  reducedMotion: false,
};

/**
 * The complete quality signal: device floor, live budget and what is eating the
 * frame.
 *
 *   const quality = useAdaptiveQuality();
 *   {quality.tier === 0 && <VolumetricLayer />}
 *   {quality.reducedMotion ? <Poster /> : <Scene />}
 *
 * Tier changes are rare, so this is React state: the gatekeeper for conditional
 * rendering of expensive work. `reasons` explains the device verdict for HUDs
 * and support.
 */
export function useAdaptiveQuality(): AdaptiveState {
  const [state, setState] = useState<AdaptiveState>(INITIAL);
  useEffect(() => getAdaptiveQuality().subscribe(setState), []);
  return state;
}
