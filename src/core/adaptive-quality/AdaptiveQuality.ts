import {
  getFramePressure,
  RENDER_CONFIDENCE_FLOOR,
  type PressureSource,
} from "../frame-pressure/FramePressure";
import {
  getAnimationBudget,
  type BudgetTier,
} from "../animation-budget/AnimationBudget";

/**
 * AdaptiveQuality: the quality signal, fusing device heuristics with the live
 * AnimationBudget.
 *
 * The budget measures real frames but is blind for the first seconds. Device
 * signals answer at once but never learn. The device tier is a floor: without
 * it a weak device oscillates, degrading until frames recover, then upgrading
 * into jank again.
 *
 * Heuristics only, no GPU benchmark database. Every tier carries `reasons`.
 */

export interface DeviceSignals {
  webgl2: boolean;
  /**
   * Whether the browser exposes WebGPU, read from `navigator.gpu`.
   *
   * This says the API exists and nothing more. Adapter limits need
   * `requestAdapter()`, which is async, so the flag doesn't move the tier. It
   * lets a scene pick a WebGPU path before that answer arrives.
   */
  webgpu: boolean;
  /** GPU renderer string (unmasked where available), "" if unknown. */
  renderer: string;
  /**
   * Whether the device has a touch screen, or null when unknown. Used only to
   * tell Apple devices apart: Safari reports "Apple GPU" on a Mac and an iPhone
   * alike. Absent reads as unknown.
   */
  touch?: boolean | null;
  /** navigator.deviceMemory in GB, null if unsupported. */
  deviceMemory: number | null;
  /** navigator.hardwareConcurrency, null if unsupported. */
  cores: number | null;
  reducedMotion: boolean;
}

export interface AdaptiveState {
  /**
   * Effective tier. Consume this one.
   *
   * The budget half is ignored while the classifier can prove the frame is
   * blocked by something reducing quality can't fix, such as another script on
   * the main thread. A smaller scene does nothing for that. The device floor
   * always applies.
   */
  tier: BudgetTier;
  label: "high" | "medium" | "low";
  deviceTier: BudgetTier;
  budgetTier: BudgetTier;
  /**
   * Why `tier` is what it is, in one machine-readable word. Branch on this.
   *
   * `device` and `reduced-motion` are floors. `render` means rendering is the
   * bottleneck, the one case reducing quality helps. `frame-rate` means the
   * frame is slow but not yet attributed, so the budget tier stands. `held`
   * means the budget tier wants to degrade and was overruled because the frame
   * is blocked elsewhere.
   */
  cause: QualityCause;
  /** Human-readable trail of why the device tier is what it is. */
  reasons: string[];
  reducedMotion: boolean;
}

const LABELS = ["high", "medium", "low"] as const;

/**
 * Why the governor arrived at the tier it did. Branch on this when a slow device
 * and a slow frame call for different responses. `held` means frames are
 * dropping but drawing isn't to blame, so reducing quality would only make the
 * page uglier.
 */
export type QualityCause =
  | "ok"
  | "device"
  | "reduced-motion"
  | "render"
  | "frame-rate"
  | "held";

/**
 * The fusion rule: would reducing quality help? Exported so tests, devtools and
 * docs use the real rule instead of a copy.
 *
 * The order matters:
 *
 * 1. Floors first. Reduced motion and a weak device are standing facts that no
 *    frame measurement overrules.
 * 2. Then the specific diagnosis. Rendering being the bottleneck is the one
 *    case a smaller scene fixes.
 * 3. Then the general one. If the budget tier wants to degrade and the
 *    classifier has no verdict, trust the budget tier. Silence only means the
 *    frame is under the attribution line.
 * 4. Refuse only on proof. A confident main-thread or runtime verdict overrules
 *    the budget tier and reports `held`.
 *
 * This answers for one instant. The AdaptiveQuality class lowers quality first
 * and holds only once that reduction was tried and frames got no faster: see
 * `Trial`.
 */
export function fuse(
  deviceTier: BudgetTier,
  budgetTier: BudgetTier,
  reducedMotion: boolean,
  pressure: { source: PressureSource; confidence: number },
): { effective: BudgetTier; cause: QualityCause } {
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

/**
 * Pure signals-to-tier heuristic, exported for tests.
 *
 * Tier 2 is the poster tier: `useSceneGate` never mounts the scene. It is kept
 * for devices that can't render or won't cope: no WebGL2, a software renderer,
 * or 2 GB of memory or less. Anything else that looks modest starts at tier 1,
 * reduced quality, and the live frame rate decides from there.
 *
 * A mobile GPU and low memory must not stack into tier 2. Chrome rounds
 * `navigator.deviceMemory` down to a power of two, so a 6 GB phone reports 4,
 * and stacking would refuse nearly every Android phone under 8 GB. A Galaxy F23
 * (Adreno 619, reports 4 GB) holds 60fps with a full hero scene.
 */
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
  } else if (
    /mali|adreno|powervr|videocore/i.test(s.renderer) ||
    // Safari reports "Apple GPU" for every Apple device, an M3 Max included, so
    // the string can't tell a phone from a Mac. Touch can: no Mac has a touch
    // screen, and an iPad asking for the desktop site still reports touch
    // points. When touch is unknown, stay cautious.
    (/apple gpu/i.test(s.renderer) && s.touch !== false)
  ) {
    // Mobile-class GPUs run GL well but live in a thermal envelope.
    tier = 1;
    reasons.push("mobile-class GPU");
  }

  if (tier < 2 && s.deviceMemory !== null && s.deviceMemory <= 2) {
    tier = 2;
    reasons.push("very little memory (2 GB or less)");
  } else {
    // A floor: modest memory or cores mean reduced quality, and they don't stack
    // with a mobile GPU into the poster tier.
    const constrained =
      (s.deviceMemory !== null && s.deviceMemory <= 4) ||
      (s.cores !== null && s.cores <= 4);
    if (constrained) {
      if (tier < 1) tier = 1;
      reasons.push("constrained memory/cores");
    }
  }

  if (reasons.length === 0) reasons.push("capable GPU");
  return { tier, reasons };
}

/**
 * What the server reports. There is no device to probe during SSR, and assuming
 * the worst would map to the poster tier: a capable machine would render the
 * fallback, hydrate, and swap to a full scene, a flash and a layout shift on
 * every good device.
 *
 * So the server reports tier 0, matching `useAdaptiveQuality`'s INITIAL. Server
 * output and first client render agree, and the real probe corrects it a frame
 * later. `useSafeToMount` starts `false` for the same reason.
 */
const SERVER_SIGNALS: DeviceSignals = {
  webgl2: false,
  webgpu: false,
  renderer: "",
  deviceMemory: null,
  cores: null,
  reducedMotion: false,
};

/**
 * A WebGL context the browser refused while the page was open.
 *
 * The device probe runs once, at load. If WebGL is refused later (Chrome blocks
 * it for a tab after a GPU reset), a gated scene would still believe the device
 * can render: R3F fails to create its context, never calls `onCreated`, and the
 * visitor gets an empty box instead of the scene's still.
 *
 * A browser that refuses a context fires `webglcontextcreationerror` at the
 * canvas, whatever asked for it, so one capture-phase listener on the document
 * hears every canvas and no adapter needs wiring. It is attached while anything
 * subscribes to AdaptiveQuality. A refusal sends the device to tier 2 until the
 * page reloads, because a browser that has blocked WebGL for a tab doesn't
 * unblock it, and asking again would only log more errors.
 *
 * Internal: exported for useSceneGate and the tests, from no entry point.
 */
let refusal: string | null = null;
const refusalWatchers = new Set<() => void>();

/** Mark WebGL refused for the rest of the visit. The first refusal wins. */
export function reportWebGLRefused(detail?: string): void {
  if (refusal !== null) return;
  refusal = detail ? `WebGL refused by the browser: ${detail}` : "WebGL refused by the browser";
  for (const watch of [...refusalWatchers]) watch();
}

/** True once the browser has refused a WebGL context on this page. */
export function isWebGLRefused(): boolean {
  return refusal !== null;
}

/** Listen on the whole page. Returns the removal. */
function listenForRefusals(): () => void {
  if (typeof document === "undefined") return () => {};
  const onRefused = (event: Event) =>
    reportWebGLRefused((event as Event & { statusMessage?: string }).statusMessage || undefined);
  document.addEventListener("webglcontextcreationerror", onRefused, true);
  return () => document.removeEventListener("webglcontextcreationerror", onRefused, true);
}

/** Tests only: forget a refusal. */
export function resetWebGLRefusalForTests(): void {
  refusal = null;
}

/** Whether there is a DOM to interrogate at all. */
function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined";
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
    /* webgl2 stays false: fail toward the floor */
  }
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: unknown };
  return {
    webgl2,
    webgpu: typeof nav.gpu === "object" && nav.gpu !== null,
    renderer,
    // Touch points or touch events. A real iPhone reports five touch points, but
    // Playwright's iPhone emulation reports none while still exposing touch
    // events. Safari on a Mac has neither.
    touch: navigator.maxTouchPoints > 0 || "ontouchstart" in window,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    cores: typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : null,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

type AdaptiveListener = (state: AdaptiveState) => void;

/** How long a reduction runs before it is judged, ms. */
const TRIAL_MS = 2000;
/** A reduction helped if frames came out at least this much faster. */
const HELPED_RATIO = 0.85;

/**
 * Whether lowering quality is helping, found out by trying it.
 *
 * The classifier alone can't be trusted to say "do not reduce". An overloaded
 * GPU can stall the main thread inside WebGL calls, and the stall reads as
 * main-thread or runtime work, which would leave a hero on a 3x screen at full
 * resolution and 30fps.
 *
 * So a slow spell is answered by reducing, and the reduction is judged after
 * TRIAL_MS. Only if frames got no faster, and the classifier blames the main
 * thread, does quality come back and stay up until the load is gone. An
 * overloaded GPU always speeds up when reduced, so it can't be held by mistake.
 * A blocked thread never does.
 */
type Trial =
  /** Frames are within budget, or a floor decides. Nothing to test. */
  | { phase: "idle" }
  /** Quality went down at `since`, when frames were taking `frameBefore` ms. */
  | { phase: "testing"; since: number; frameBefore: number }
  /** Reducing did not help and the main thread is to blame: full quality until the budget recovers. */
  | { phase: "held" }
  /** Reducing helped, or rendering was named as the cause: stay reduced until the budget recovers. */
  | { phase: "reduced" };

class AdaptiveQuality {
  private trial: Trial = { phase: "idle" };
  private device: { tier: BudgetTier; reasons: string[] } | null = null;
  private signals: DeviceSignals | null = null;
  private budgetTier: BudgetTier = 0;
  private listeners = new Set<AdaptiveListener>();
  private offBudget: (() => void) | null = null;
  private offPressure: (() => void) | null = null;
  private offRefusal: (() => void) | null = null;
  /** What listeners last heard, so a verdict that changes nothing stays quiet. */
  private emitted: { tier: BudgetTier; cause: QualityCause } | null = null;

  constructor() {
    // A refusal changes the device tier, so every listener must hear it at once.
    refusalWatchers.add(() => this.emit(true));
  }

  /** The probed device, or the poster tier once WebGL has been refused. */
  private currentDevice(): { tier: BudgetTier; reasons: string[] } {
    this.ensureProbe();
    if (refusal === null) return this.device!;
    return { tier: 2, reasons: [...this.device!.reasons, refusal] };
  }

  get state(): AdaptiveState {
    const device = this.currentDevice();
    const deviceTier = device.tier;
    const fused = fuse(deviceTier, this.budgetTier, this.signals!.reducedMotion, getFramePressure().state);
    let { effective, cause } = fused;
    // `fuse()` says "held" when the main thread is blamed, but that waits for a
    // trial to prove it. Until then, and when a trial shows reducing helps, the
    // budget tier stands. Once proven, the hold outlasts its block: the budget
    // tier needs eight clean seconds to recover, and a scene that was never
    // reduced has nothing to recover from.
    if (cause === "held" || cause === "frame-rate") {
      if (this.trial.phase === "held") {
        effective = deviceTier;
        cause = "held";
      } else {
        effective = this.budgetTier;
        cause = "frame-rate";
      }
    }
    return {
      tier: effective,
      label: LABELS[effective],
      deviceTier,
      budgetTier: this.budgetTier,
      cause,
      reasons: device.reasons,
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
        if (changed) this.emit(true);
      });
    }
    // `fuse()` decides from FramePressure's verdict, and FramePressure only
    // measures while something is subscribed. Holding the subscription here
    // means the rule can't depend on some caller remembering to.
    if (this.offPressure === null) {
      this.offPressure = getFramePressure().subscribe(() => this.emit(false));
    }
    if (this.offRefusal === null) this.offRefusal = listenForRefusals();
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) {
        this.offBudget?.();
        this.offBudget = null;
        this.offPressure?.();
        this.offPressure = null;
        this.offRefusal?.();
        this.offRefusal = null;
        this.budgetTier = 0;
        this.emitted = null;
        this.trial = { phase: "idle" };
      }
    };
  }

  /** Move the trial along. Called on every budget change and every verdict. */
  private step(): void {
    const deviceTier = this.currentDevice().tier;
    const pressure = getFramePressure().state;
    const { cause } = fuse(deviceTier, this.budgetTier, this.signals!.reducedMotion, pressure);

    // Nothing slow to answer, or a floor already answers it.
    if (cause !== "held" && cause !== "frame-rate" && cause !== "render") {
      this.trial = { phase: "idle" };
      return;
    }
    // Rendering named with confidence: reducing is the right answer, and a
    // later main-thread verdict in the same spell does not get to undo it.
    if (cause === "render") {
      this.trial = { phase: "reduced" };
      return;
    }

    const now = performance.now();
    if (this.trial.phase === "idle") {
      this.trial =
        pressure.frameMs > 0 ? { phase: "testing", since: now, frameBefore: pressure.frameMs } : { phase: "reduced" };
    } else if (this.trial.phase === "testing" && now - this.trial.since >= TRIAL_MS) {
      const faster = pressure.frameMs <= this.trial.frameBefore * HELPED_RATIO;
      const blamed =
        pressure.confidence >= RENDER_CONFIDENCE_FLOOR &&
        (pressure.source === "main-thread" || pressure.source === "runtime");
      this.trial = !faster && blamed ? { phase: "held" } : { phase: "reduced" };
    }
  }

  /**
   * Tell listeners. A budget tier change always goes out. A new verdict goes out
   * only when it changes the tier or the cause: FramePressure reports twice a
   * second, and each report is a React render in every component holding the
   * hook.
   */
  private emit(force: boolean): void {
    if (this.listeners.size === 0) return;
    this.step();
    const s = this.state;
    const same = this.emitted !== null && this.emitted.tier === s.tier && this.emitted.cause === s.cause;
    if (same && !force) return;
    this.emitted = { tier: s.tier, cause: s.cause };
    for (const l of [...this.listeners]) l(s);
  }

  private ensureProbe(): void {
    if (this.device !== null) return;

    // `navigator.hardwareConcurrency` and `window.matchMedia` don't exist on a
    // server, and this entry is framework-agnostic, so a Vue or Svelte page can
    // read the governor during SSR.
    if (!isBrowser()) {
      this.signals = SERVER_SIGNALS;
      this.device = { tier: 0, reasons: ["not probed: no browser environment"] };
      return;
    }

    this.signals = probeDeviceSignals();
    this.device = deviceTierFromSignals(this.signals);
  }
}

let instance: AdaptiveQuality | null = null;

/** Lazy singleton: client-only construction, safe to import in SSR. */
export function getAdaptiveQuality(): AdaptiveQuality {
  if (instance === null) instance = new AdaptiveQuality();
  return instance;
}
