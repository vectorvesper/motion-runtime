/**
 * The benchmark scenarios, shared by the CDP harness and the device page.
 *
 * One copy. The desktop harness drives these over the debugging protocol; a
 * phone runs the same code through a page with buttons on it, because you
 * cannot attach a debugger to someone's iPhone and the numbers have to be
 * comparable either way.
 */

import { getConductor, getAdaptiveQuality } from "/dist/index.js";

let LOAD = 220;
/**
 * How many times the work actually ran.
 *
 * Reported alongside frame time because the coordinated arm reaches 60fps
 * partly by choosing not to do everything. Publishing the frame win without
 * this number would hide the trade the design is making.
 */
let workCount = 0;

/**
 * Which frames one particular decorative element actually ran on.
 *
 * Page frame rate is not what a viewer looks at. They look at a thing moving,
 * and a thing that runs on frames 1,2,7,8,9,14 is visibly worse than one that
 * runs on every third frame — even though both "drop two thirds". Shedding is
 * greedy per frame, so it produces the first pattern unless something makes it
 * produce the second.
 */
let frameNo = 0;
let tracked = [];
const TRACKED_INDEX = 40;

let stage = null;
export function setStage(el) {
  stage = el;
}

/**
 * The work being measured, identical in every arm.
 *
 * Touches only compositor-friendly properties. If two arms did different work
 * the comparison would measure the work rather than the coordination, which is
 * the only thing under test.
 */
function work(el, i, t) {
  workCount++;
  if (i === TRACKED_INDEX) tracked.push(frameNo);
  let acc = 0;
  for (let k = 0; k < LOAD; k++) acc += Math.sin(t * 0.001 + k + i) * Math.cos(k - i);
  const x = 20 + (i % 8) * 90 + Math.sin(t * 0.0012 + i) * 30 + acc * 0.02;
  const y = 20 + Math.floor(i / 8) * 70 + Math.cos(t * 0.0016 + i) * 24;
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function buildDots(count) {
  stage.innerHTML = "";
  const dots = [];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = i === 0 ? "dot lead" : "dot";
    stage.appendChild(el);
    dots.push(el);
  }
  return dots;
}

/**
 * Frame intervals, collected by a private rAF loop.
 *
 * A private loop is exactly what the runtime tells components not to do, and
 * exactly what an instrument must do — it has to sit outside the system it
 * measures. A subscriber could be shed, which would mean the ruler shrinking
 * whenever the thing being measured got heavy.
 */
function recorder() {
  const intervals = [];
  let last = 0;
  let alive = true;
  const tick = (t) => {
    if (!alive) return;
    frameNo++;
    if (last) intervals.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { intervals, stop: () => { alive = false; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every animation on its own rAF loop, which is what most pages look like. */
function armPrivateLoops(dots) {
  let alive = true;
  for (let i = 0; i < dots.length; i++) {
    const tick = (t) => {
      if (!alive) return;
      work(dots[i], i, t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  return () => { alive = false; };
}

/**
 * All of it on the shared loop, with honest priorities.
 *
 * `hz` throttles the scenery to a fixed cadence instead of leaving it to be
 * shed. Both end up doing less work; only one of them does it on a predictable
 * beat, and predictability is what the eye is actually judging.
 */
function armShared(dots, { shedding, decorativeHz = 0 }) {
  getConductor().configure({ shedding });
  const offs = dots.map((el, i) => {
    const priority = i === 0 ? "essential" : i < 8 ? "enhanced" : "decorative";
    return getConductor().subscribe("render", (_dt, t) => work(el, i, t * 1000), {
      // The lead dot stands for the thing the visitor is using. The rest is
      // scenery.
      priority,
      ...(priority === "decorative" && decorativeHz ? { hz: decorativeHz } : {}),
      label: i === 0 ? "lead" : `dot-${i}`,
    });
  });
  return () => offs.forEach((off) => off());
}

export const SCENARIOS = {
  /**
   * The same animations, coordinated versus not.
   *
   * The claim is that one scheduler that knows what everything costs can hold a
   * frame rate that N independent loops cannot.
   */
  "many-animations": {
    count: 48,
    arms: {
      "private loops": (dots) => armPrivateLoops(dots),
      "shared loop": (dots) => armShared(dots, { shedding: true }),
    },
  },

  /**
   * Can one important animation keep running while the page is overloaded?
   *
   * Both arms use the shared loop; only shedding changes. That isolates the
   * scheduling decision from the loop itself — a shared rAF loop is not novel,
   * and GSAP and Motion both have one.
   */
  "protect-the-lead": {
    count: 90,
    arms: {
      "no shedding": (dots) => armShared(dots, { shedding: false }),
      "shedding on": (dots) => armShared(dots, { shedding: true }),
      "shed + 30Hz": (dots) => armShared(dots, { shedding: true, decorativeHz: 30 }),
    },
  },
};

async function measure(arm, { count, ms }) {
  const dots = buildDots(count);
  await new Promise((r) => requestAnimationFrame(() => r()));

  workCount = 0;
  frameNo = 0;
  tracked = [];
  const rec = recorder();
  const stop = arm(dots);
  await sleep(ms);

  const stats = getConductor().state;
  const lead = stats.subscribers.find((s) => s.label === "lead") ?? null;
  const shedTotal = stats.subscribers.reduce((n, s) => n + s.shed, 0);

  stop();
  rec.stop();
  stage.innerHTML = "";
  await sleep(400);

  // Gaps between the tracked element's runs, in frames.
  const gaps = [];
  for (let i = 1; i < tracked.length; i++) gaps.push(tracked[i] - tracked[i - 1]);

  return {
    intervals: rec.intervals,
    gaps,
    workDone: workCount,
    lead: lead ? { runs: lead.runs, shed: lead.shed } : null,
    shedTotal,
  };
}

export async function run(name, armName, ms = 5000, load = 220) {
  if (document.hidden) return { error: "document.hidden — rAF is paused" };
  LOAD = load;
  const scenario = SCENARIOS[name];
  return measure(scenario.arms[armName], { count: scenario.count, ms });
}

/**
 * A long run at heavy load, sampling frame rate and the quality tier every
 * second.
 *
 * This is the only scenario a desktop cannot fake. A mobile GPU is fine for
 * twenty or thirty seconds and then is not, and `useAdaptiveQuality`'s device
 * floor is a bet on exactly that. Three minutes is long enough to see whether
 * the bet pays: if the frame rate sags and the tier does not move, the floor is
 * not doing its job.
 */
export async function thermal({ ms = 180000, load = 4000, count = 90 } = {}) {
  if (document.hidden) return { error: "document.hidden — rAF is paused" };
  LOAD = load;

  const dots = buildDots(count);
  await new Promise((r) => requestAnimationFrame(() => r()));

  const samples = [];
  const rec = recorder();
  const stop = armShared(dots, { shedding: true });

  const started = performance.now();
  let mark = 0;
  while (performance.now() - started < ms) {
    await sleep(1000);
    const window = rec.intervals.slice(mark);
    mark = rec.intervals.length;
    const avg = window.length
      ? window.reduce((a, b) => a + b, 0) / window.length
      : 0;
    const q = getAdaptiveQuality().state;
    samples.push({
      second: Math.round((performance.now() - started) / 1000),
      fps: avg ? Math.round(1000 / avg) : 0,
      tier: q.tier,
      deviceTier: q.deviceTier,
      budgetTier: q.budgetTier,
    });
  }

  stop();
  rec.stop();
  stage.innerHTML = "";
  return { samples };
}

/** What this device says about itself, for the results header. */
export function deviceInfo() {
  const q = getAdaptiveQuality().state;
  let renderer = "unknown";
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl) renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    /* no webgl2 — the tier already reflects that */
  }
  return {
    ua: navigator.userAgent,
    renderer,
    cores: navigator.hardwareConcurrency ?? null,
    memory: navigator.deviceMemory ?? null,
    dpr: devicePixelRatio,
    screen: `${screen.width}x${screen.height}`,
    displayHz: getConductor().state.displayHz,
    tier: q.tier,
    deviceTier: q.deviceTier,
    reasons: q.reasons,
    reducedMotion: q.reducedMotion,
  };
}
