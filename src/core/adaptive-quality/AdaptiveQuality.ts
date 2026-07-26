import {
  getAnimationBudget,
  type BudgetTier,
} from "../animation-budget/AnimationBudget";

/**
 * AdaptiveQuality — the complete quality signal: static device heuristics
 * fused with the live AnimationBudget.
 *
 * Why both: the budget measures TRUTH but only after frames accumulate —
 * the first seconds are blind. Device signals guess instantly but never
 * learn. Fusion rule: `tier = max(deviceTier, budgetTier)` — the device
 * tier is a FLOOR. Without it, weak devices oscillate: degrade → frames
 * recover (because we degraded) → upgrade → jank → degrade, forever.
 * A software renderer stays a software renderer; the floor encodes that.
 *
 * Own heuristics, zero deps (no GPU benchmark databases): conservative,
 * explainable (`reasons`), refined by measurement rather than trusted.
 */

export interface DeviceSignals {
  webgl2: boolean;
  /** GPU renderer string (unmasked where available), "" if unknown. */
  renderer: string;
  /** navigator.deviceMemory in GB, null if unsupported. */
  deviceMemory: number | null;
  /** navigator.hardwareConcurrency, null if unsupported. */
  cores: number | null;
  reducedMotion: boolean;
}

export interface AdaptiveState {
  /** Effective tier: max(deviceTier, budgetTier). Consume THIS one. */
  tier: BudgetTier;
  label: "high" | "medium" | "low";
  deviceTier: BudgetTier;
  budgetTier: BudgetTier;
  /** Human-readable trail of why the device tier is what it is. */
  reasons: string[];
  reducedMotion: boolean;
}

const LABELS = ["high", "medium", "low"] as const;

/** Pure signals→tier heuristic (exported for tests). Conservative on purpose. */
export function deviceTierFromSignals(s: DeviceSignals): {
  tier: BudgetTier;
  reasons: string[];
} {
  if (!s.webgl2) return { tier: 2, reasons: ["no WebGL2"] };

  let tier: BudgetTier = 0;
  const reasons: string[] = [];

  if (/swiftshader|llvmpipe|software|basic render/i.test(s.renderer)) {
    tier = 2;
    reasons.push("software GL renderer");
  } else if (/mali|adreno|powervr|videocore|apple gpu/i.test(s.renderer)) {
    // Mobile-class GPUs run GL well but live in a thermal envelope.
    tier = 1;
    reasons.push("mobile-class GPU");
  }

  const constrained =
    (s.deviceMemory !== null && s.deviceMemory <= 4) ||
    (s.cores !== null && s.cores <= 4);
  if (constrained && tier < 2) {
    tier = (tier + 1) as BudgetTier;
    reasons.push("constrained memory/cores");
  }

  if (reasons.length === 0) reasons.push("capable GPU");
  return { tier, reasons };
}

function probeDeviceSignals(): DeviceSignals {
  let webgl2 = false;
  let renderer = "";
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (gl) {
      webgl2 = true;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = String(
        ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      );
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* webgl2 stays false — fail toward the floor */
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    webgl2,
    renderer,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    cores: typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : null,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

type AdaptiveListener = (state: AdaptiveState) => void;

class AdaptiveQuality {
  private device: { tier: BudgetTier; reasons: string[] } | null = null;
  private signals: DeviceSignals | null = null;
  private budgetTier: BudgetTier = 0;
  private listeners = new Set<AdaptiveListener>();
  private offBudget: (() => void) | null = null;

  get state(): AdaptiveState {
    this.ensureProbe();
    const deviceTier = this.device!.tier;
    const tier = Math.max(deviceTier, this.budgetTier) as BudgetTier;
    return {
      tier,
      label: LABELS[tier],
      deviceTier,
      budgetTier: this.budgetTier,
      reasons: this.device!.reasons,
      reducedMotion: this.signals!.reducedMotion,
    };
  }

  subscribe(fn: AdaptiveListener): () => void {
    this.ensureProbe();
    this.listeners.add(fn);
    if (this.offBudget === null) {
      this.offBudget = getAnimationBudget().subscribe((budget) => {
        const changed = budget.tier !== this.budgetTier;
        this.budgetTier = budget.tier;
        if (changed) {
          const s = this.state;
          for (const l of [...this.listeners]) l(s);
        }
      });
    }
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.offBudget !== null) {
        this.offBudget();
        this.offBudget = null;
        this.budgetTier = 0;
      }
    };
  }

  private ensureProbe(): void {
    if (this.device !== null) return;
    this.signals = probeDeviceSignals();
    this.device = deviceTierFromSignals(this.signals);
  }
}

let instance: AdaptiveQuality | null = null;

/** Lazy singleton — client-only construction, SSR-import-safe. */
export function getAdaptiveQuality(): AdaptiveQuality {
  if (instance === null) instance = new AdaptiveQuality();
  return instance;
}
