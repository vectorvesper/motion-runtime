import { getFramePressure, type PressureSource } from "../frame-pressure/FramePressure";
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
  /**
   * Effective tier. Consume THIS one.
   *
   * Up to 2.x this was `max(deviceTier, budgetTier)` and nothing more, which
   * meant it degraded whenever the frame rate sagged, including when the cause
   * was somebody else's script blocking the main thread. A smaller scene does
   * nothing for that: it makes the page uglier and exactly as slow.
   *
   * Since 3.0 the budget half is ignored while the classifier can prove the
   * frame is blocked by something reducing quality cannot fix. The device floor
   * is never ignored.
   */
  tier: BudgetTier;
  label: "high" | "medium" | "low";
  deviceTier: BudgetTier;
  budgetTier: BudgetTier;
  /**
   * Why `tier` is what it is, in one machine-readable word. Branch on this.
   *
   * `device` and `reduced-motion` are floors. `render` means rendering is
   * measurably the bottleneck, which is the one case reducing quality helps.
   * `frame-rate` means the frame is slow but the classifier cannot attribute
   * it yet, so the budget tier is trusted. `held` means the budget tier wants
   * to degrade and was overruled because the frame is blocked elsewhere.
   */
  cause: "ok" | "device" | "reduced-motion" | "render" | "frame-rate" | "held";
  /** Human-readable trail of why the device tier is what it is. */
  reasons: string[];
  reducedMotion: boolean;
}

const LABELS = ["high", "medium", "low"] as const;

/**
 * A render verdict below this confidence is not acted on. A realistic heavy
 * scene measures about 0.52 in a real browser, so the floor has to sit under
 * that while still rejecting a coin-flip.
 */
const RENDER_CONFIDENCE_FLOOR = 0.4;

/**
 * Would reducing quality actually help?
 *
 * Pure, and exported for tests, because this is the rule the whole runtime is
 * built around and it used to live inside useSceneGate where only one caller
 * could reach it. Twenty-one components read the governor directly and got the
 * naive answer.
 *
 * The order matters:
 *
 * 1. **Floors first.** Reduced motion and a weak device are not opinions about
 *    the current frame, they are standing facts, and no frame measurement
 *    overrules them.
 * 2. **Then the specific diagnosis.** Rendering being the bottleneck is the one
 *    case a smaller scene fixes.
 * 3. **Then the general one.** If the budget tier wants to degrade and the
 *    classifier has no verdict, trust the budget tier. Silence from the
 *    classifier means the frame is under its attribution line, not that
 *    nothing is wrong.
 * 4. **Refuse only when we can prove it would not help.** A confident
 *    main-thread or runtime verdict is the one case where degrading is known
 *    to be useless, so the budget tier is overruled and reported as `held`.
 */
export function fuse(
  deviceTier: BudgetTier,
  budgetTier: BudgetTier,
  reducedMotion: boolean,
  pressure: { source: PressureSource; confidence: number },
): { effective: BudgetTier; cause: AdaptiveState["cause"] } {
  if (reducedMotion) return { effective: 2, cause: "reduced-motion" };
  if (deviceTier >= budgetTier && deviceTier > 0) {
    return { effective: deviceTier, cause: "device" };
  }

  const confident = pressure.confidence >= RENDER_CONFIDENCE_FLOOR;

  if (pressure.source === "render" && confident) {
    return { effective: Math.max(deviceTier, budgetTier) as BudgetTier, cause: "render" };
  }

  if (budgetTier > deviceTier) {
    const blockedElsewhere =
      confident && (pressure.source === "main-thread" || pressure.source === "runtime");
    if (blockedElsewhere) return { effective: deviceTier, cause: "held" };
    return { effective: budgetTier, cause: "frame-rate" };
  }

  return { effective: deviceTier, cause: deviceTier > 0 ? "device" : "ok" };
}

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
    const { effective, cause } = fuse(
      deviceTier,
      this.budgetTier,
      this.signals!.reducedMotion,
      getFramePressure().state,
    );
    return {
      tier: effective,
      label: LABELS[effective],
      deviceTier,
      budgetTier: this.budgetTier,
      cause,
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
