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
  /**
   * Whether the browser exposes WebGPU at all.
   *
   * Detected synchronously from `navigator.gpu`, which says the API exists and
   * nothing more. Adapter limits and the device tier behind them need
   * `requestAdapter()`, which is async and therefore cannot inform the first
   * synchronous probe. This flag is here so a scene can choose a WebGPU path
   * before that answer arrives; it deliberately does not move the tier.
   */
  webgpu: boolean;
  /** GPU renderer string (unmasked where available), "" if unknown. */
  renderer: string;
  /**
   * Whether the device has a touch screen (touch points or touch events), or
   * null when unknown.
   *
   * Read only to tell Apple devices apart: Safari reports "Apple GPU" on a Mac
   * and on an iPhone alike. Optional, so signals built by hand elsewhere still
   * type-check; absent reads as unknown.
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
  cause: QualityCause;
  /** Human-readable trail of why the device tier is what it is. */
  reasons: string[];
  reducedMotion: boolean;
}

const LABELS = ["high", "medium", "low"] as const;

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
 *
 * This is the answer from what is known at one instant. The AdaptiveQuality
 * class does not act on a `held` answer straight away: it lowers quality
 * first, and holds only once that reduction has been tried and did not make
 * frames faster. See `Trial` below for why.
 */
/**
 * Why the governor arrived at the tier it did.
 *
 * Branch on this when a slow device and a slow frame call for different
 * responses. `held` is the interesting one: frames are dropping, but something
 * other than drawing is to blame, so reducing quality would make the page
 * uglier without making it faster.
 */
export type QualityCause =
  | "ok"
  | "device"
  | "reduced-motion"
  | "render"
  | "frame-rate"
  | "held";

/**
 * The fusion rule, as a pure function.
 *
 * Exported for the same reason `SAFE_TO_MOUNT_COST` and
 * `POINTER_INTENT_SENSITIVITY` are: a devtools panel or a docs page explaining
 * a verdict needs the real rule, and the alternative is every such surface
 * keeping a copy that drifts out of date. The adaptive-quality documentation
 * page had exactly that, still computing `max(deviceTier, budgetTier)` long
 * after 3.0 replaced it.
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
 * Pure signals→tier heuristic (exported for tests). Conservative on purpose,
 * but only tier 2 withholds a scene, so tier 2 is kept for devices that really
 * cannot run one.
 *
 * Tier 2 is the poster tier: `useSceneGate` never mounts the scene. It is for
 * what cannot render at all or will not cope: no WebGL2, a software renderer,
 * or 2 GB of memory or less. Everything else that looks modest starts at tier
 * 1, reduced quality, and the live frame rate decides from there.
 *
 * Up to 4.3.2 a mobile GPU and 4 GB of memory stacked, one tier each, to tier
 * 2. Chrome rounds `navigator.deviceMemory` down to a power of two, so a 6 GB
 * phone reports 4, and nearly every Android phone under 8 GB got the poster.
 * On 2026-10-27 a Galaxy F23 (Adreno 619, reported 4 GB) was refused vv-site's
 * landing hero, then held 60 fps with it for three minutes once allowed (vault
 * RB-4). Safari reports no memory, so iPhones were never affected.
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
    // the string alone cannot tell a phone from a Mac: up to 4.1.0 every Mac on
    // Safari started at tier 1. Touch can. No Mac has a touch screen, and an
    // iPad asking for the desktop site still reports touch points. When touch
    // is unknown the old, cautious reading stands.
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
    // A floor, not a step: modest memory or cores mean reduced quality, and
    // they no longer stack with a mobile GPU into the poster tier.
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
 * What the server reports, and why it is optimistic.
 *
 * There is no device to probe during SSR. The tempting default is the honest
 * one, "we know nothing, assume the worst", but `deviceTierFromSignals` maps
 * `webgl2: false` to tier 2, which is the poster tier. A Nuxt or SvelteKit page
 * would render the static fallback, hydrate, probe a perfectly capable GPU and
 * swap to a full scene: a flash and a layout shift on every good machine.
 *
 * So the server reports tier 0, which is exactly what `useAdaptiveQuality`'s
 * INITIAL already renders on the React side. Server output and first client
 * render agree, and the real probe corrects it a frame later if the device
 * deserves it. Same reasoning as `useSafeToMount` starting `false`.
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
 * The device probe runs once, when the page loads. If WebGL is refused later
 * (Chrome blocks it for a tab after a GPU reset: "Web page caused context loss
 * and was blocked"), a gated scene still believed the device could render: R3F
 * failed to create its context, never called `onCreated`, and the visitor got
 * an empty box instead of the scene's still. vv-site's footer did exactly that
 * on 2026-10-25 (vault RB-3).
 *
 * A browser that refuses a context fires `webglcontextcreationerror` at the
 * canvas, whatever asked for it: R3F, three.js or hand-written code. One
 * capture-phase listener on the document hears it from every canvas on the
 * page, so no adapter has to be wired for it. It is attached while anything
 * subscribes to AdaptiveQuality, which every gate does, and removed with the
 * last subscriber, so the page is left as it was found. The refusal sends the
 * device to tier 2, so every gate shows its still, and it lasts until the page
 * reloads: a browser that has blocked WebGL for a tab does not unblock it, and
 * asking again would only log more errors.
 *
 * Internal: exported for useSceneGate and the tests, and from no entry point.
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
    /* webgl2 stays false — fail toward the floor */
  }
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: unknown };
  return {
    webgl2,
    webgpu: typeof nav.gpu === "object" && nav.gpu !== null,
    renderer,
    // Touch points or touch events, either one. A real iPhone reports five
    // touch points, but Playwright's iPhone emulation reports none while still
    // exposing touch events; Safari on a Mac has neither.
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
 * Whether lowering quality is actually helping, found out by trying it.
 *
 * The classifier alone cannot be trusted to say "do not reduce". An overloaded
 * GPU can stall the main thread inside WebGL calls, and the stall reads as
 * main-thread or runtime work: in vv-lab on 2026-10-19 a `useThreeScene` hero
 * on a 3x screen held full resolution at 30fps for twelve seconds because of
 * it. So a slow spell is answered the way it always was, by reducing, and the
 * reduction is judged after TRIAL_MS. Only if frames did not get faster, and
 * the classifier blames the main thread, does quality come back and stay up
 * until the load is gone. An overloaded GPU always speeds up when reduced, so
 * it can never be held by mistake. A blocked thread never does (vault RB-2).
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
    // A refusal changes the device tier, so every listener has to hear it now,
    // not at the next budget or pressure change.
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
    // A slow frame with no rendering verdict. `fuse()` says "held" when the
    // main thread is blamed, but that waits for a trial to prove it; until
    // then, and when a trial shows reducing helps, the budget tier stands.
    // Once proven, the hold also outlasts its block: the budget tier waits out
    // eight clean seconds before it recovers, and a scene that was never
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
    // measures while something is subscribed. Until 4.0.0 useSceneGate called
    // useFramePressure() itself, which kept it running for every gated scene;
    // when the rule moved in here, that subscription went with the old code and
    // nothing replaced it. The verdict sat at its initial "none", so a blocked
    // main thread read as plain slow frames and lowered quality, and the "held"
    // and "render" branches never ran (vault RB-2). Holding the subscription
    // here means the rule can no longer depend on some caller remembering to.
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
   * Tell listeners. A budget tier change always goes out, as it did before.
   * A new verdict goes out only when it changes the tier or the cause:
   * FramePressure reports twice a second, and each report is a React render in
   * every component holding the hook.
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

    // Reading `.state` during SSR used to throw "window is not defined": the
    // canvas probe was inside a try/catch but `navigator.hardwareConcurrency`
    // and `window.matchMedia` were not. This entry carries no "use client" and
    // is advertised as framework-agnostic, so a Vue or Svelte page reading the
    // governor on the server crashed the render. React consumers never saw it,
    // because the hook sits behind a client boundary.
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

/** Lazy singleton — client-only construction, SSR-import-safe. */
export function getAdaptiveQuality(): AdaptiveQuality {
  if (instance === null) instance = new AdaptiveQuality();
  return instance;
}
