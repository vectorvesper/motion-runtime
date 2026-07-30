<div align="center">

# @vectorvesper/motion

**Motion primitives, built on one shared frame loop.**
A sensor layer, a frame-budget governor, and a set of React hooks that all ride a single heartbeat — so motion stays smooth as a page grows.

[![npm](https://img.shields.io/npm/v/@vectorvesper/motion.svg?color=8b5cf6)](https://www.npmjs.com/package/@vectorvesper/motion)
![zero dependencies](https://img.shields.io/badge/dependencies-0-10b981)
![types included](https://img.shields.io/badge/types-included-38bdf8)
[![license](https://img.shields.io/badge/license-MIT-a3a3a3)](./LICENSE)

</div>

---

**Primitives, not a component library.** Most pages accumulate a dozen uncoordinated `requestAnimationFrame` loops, each attaching its own listeners and reading layout whenever it likes — the recipe for jank. `@vectorvesper/motion` gives every effect **one** heartbeat, **one** shared input layer, and a live performance budget they all obey. The core is **zero-dependency** and framework-agnostic; the React hooks are thin adapters on top.

Because one loop can see every effect at once, it can do something a pile of independent components structurally cannot: **when a frame runs long, it drops the least important work rather than letting everything degrade together.**

The engine is **free and MIT** — read every line. Vector Vesper's paid catalog is the polished components built *on* these primitives, never the primitives themselves.

## Install

```bash
npm install @vectorvesper/motion
```

React hooks need `react` and `react-dom` (>=18) as peers — you almost certainly already have them. The core needs nothing.

## Quick start

**Core — works anywhere** (vanilla, Vue, Svelte, Framer, …). One shared loop, frame-rate-independent smoothing:

```ts
import { getConductor, damp } from "@vectorvesper/motion";

let x = 0;
const off = getConductor().subscribe("render", (dt) => {
  x = damp(x, targetX, 12, dt);          // smooth, frame-rate independent
  el.style.transform = `translate3d(${x}px, 0, 0)`;
});
// off() to unsubscribe — the loop sleeps when its last subscriber leaves.
```

**React** — render the expensive version only on hardware that can actually hold the frame:

```tsx
import { useAdaptiveQuality } from "@vectorvesper/motion/react";

function Hero() {
  const { tier } = useAdaptiveQuality();   // device floor fused with the live frame budget
  return tier === 0 ? <ShaderBackground /> : <StaticGradient />;
}
```

`tier` degrades on a struggling device and recovers when the page settles — so the same code ships a rich experience to a desktop and a calm one to a mid-range phone, without you branching on user-agent guesses.

## What's inside

Two layers. The **foundation** is the shared runtime and the primitives that sense, govern, and predict — the coordination that keeps a busy page smooth. The **creative hooks** are self-contained effects you reach for to build a specific thing.

### Foundation

Every one of these rides the same loop and input layer — that coordination is the point.

| Primitive | React hook | What it does |
| --- | --- | --- |
| **FrameConductor** | — | One `rAF` loop for the page, three ordered lanes (`input → update → render`), zero idle cost. |
| **SensorBus** | `useSensorBus` | One set of pointer / scroll / viewport listeners, with damped velocity, shared by every reader. |
| **AnimationBudget** | `useAnimationBudget` | Live frame-headroom governor → a stable quality tier (`high` / `medium` / `low`). |
| **AdaptiveQuality** | `useAdaptiveQuality` | A conservative device floor fused with the live budget — consume the worse of the two. |
| — | `useSafeToMount` | Mount an expensive subtree only once there's real frame headroom. |
| — | `useLazyScene` | Defer a heavy scene until it's in view and the page is idle. |
| **PointerIntent** | `usePointerIntent` | Predicts the pointer is *heading for* an element before it hovers — for pre-fetching expensive assets on desktop. |
| **MagneticElement** | `useMagneticIntent` | A magnetic pull toward the cursor. |

### Creative hooks

Ready-to-use effects. Reach for one when you want the specific thing it does.

| React hook | What it does |
| --- | --- |
| `useVideoScrubber` | Drive a video timeline from scroll or pointer. |
| `useNumberTicker` | Animate a number to its target, written straight to the DOM. |
| `useImageTrail` | A trail of images that follows the pointer (self-contained, compositor-driven). |

Plus math utilities: `damp`, `clamp01`, `rayRectIntersect`.

## Why one loop

```
Typical page                          @vectorvesper/motion
────────────                          ────────────────────
N components → N rAF loops            N components → 1 loop
each with its own listeners           one shared input layer
reads & writes interleaved            all reads, then all writes
no shared performance signal          one budget everyone obeys
```

Because reads (`input`) always finish before writes (`render`) in the shared loop, the browser recomputes layout at most once per frame — no matter how many effects subscribe. Add more motion and the loop count stays at exactly **one**.

## Scheduling

Subscribers declare what they are, and the loop spends the frame accordingly:

```ts
getConductor().subscribe("render", draw, {
  priority: "decorative",   // "essential" | "enhanced" | "decorative"
  hz: 30,                   // optional cadence cap
  label: "AuroraBackground" // shows up in devtools
});
```

| Priority | Meaning | Shed when |
| --- | --- | --- |
| `essential` | Sensors, governors, direct manipulation | Never |
| `enhanced` | Interaction feedback *(default)* | Frame is ~70% spent |
| `decorative` | Ambient garnish | Frame is ~45% spent |

Shedding is per frame, and nothing starves — a subscriber skipped four frames running is forced through, so heavy pages degrade decorative work to a **lower cadence** instead of freezing it. `hz` passes the accumulated `dt` through, so damping stays frame-rate independent: an ambient layer at 30Hz looks identical and costs half.

The budget is the **measured display refresh rate**, not an assumed 60Hz — 5ms of work is comfortable on a 60Hz panel and over the line on a 120Hz one.

## Devtools

The value is invisible until you can watch it. `@vectorvesper/motion/devtools` answers the question no component library can: **which effect on this page is eating the frame?**

```ts
import { mountDevtools } from "@vectorvesper/motion/devtools";

if (process.env.NODE_ENV !== "production") mountDevtools();
```

```
fps 60        frame 16.7ms      runtime work 2.14ms
headroom 12.4ms   tier 0 high   shed/frame 0

  4.00ms  Sparkles          render  decorative  runs=36 shed=24
  2.00ms  MagneticElement   render  enhanced    runs=60 shed=0
  1.00ms  SensorBus         input   essential   runs=60 shed=0
```

Zero dependencies, no framework — it's a DOM function, so call it from a React effect, a Vue `onMounted`, or the console. It renders into a shadow root and refreshes at 5Hz. Separate entry point, so it only reaches bundles that ask for it.

## Three entry points

```ts
// core — zero-dep, framework-agnostic
import { getConductor, getSensorBus, damp } from "@vectorvesper/motion";

// react — hooks (react + react-dom peers)
import { useSensorBus, useAdaptiveQuality } from "@vectorvesper/motion/react";

// devtools — the live inspector
import { mountDevtools } from "@vectorvesper/motion/devtools";
```

Ships **ESM + CJS + TypeScript types**, and resolves under modern *and* classic module resolution — so it works in Vite, esbuild, Next.js, and Framer's code editor alike.

## Stability

The public API is **frozen at 1.0**. The exported surface — the hooks, the four singleton accessors, the pure helpers — is what the package commits to supporting; a build-time guard fails the release if it drifts. You can build on it without worrying it moves under you.

## Documentation

Guides, the full API reference, and live interactive labs for every primitive:

**→ [vectorvesper.dev](https://vectorvesper.dev)**

## License

[MIT](./LICENSE) © Vector Vesper
