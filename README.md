<div align="center">

# @vectorvesper/motion

**The motion runtime behind [Vector Vesper](https://vectorvesper.dev).**
One frame loop, one input layer, and a frame-budget governor — so motion stays smooth as a page grows.

[![npm](https://img.shields.io/npm/v/@vectorvesper/motion.svg?color=8b5cf6)](https://www.npmjs.com/package/@vectorvesper/motion)
![zero dependencies](https://img.shields.io/badge/dependencies-0-10b981)
![types included](https://img.shields.io/badge/types-included-38bdf8)
[![license](https://img.shields.io/badge/license-MIT-a3a3a3)](./LICENSE)

</div>

---

It's a **runtime, not a component library.** Most pages accumulate a dozen uncoordinated `requestAnimationFrame` loops, each attaching its own listeners and reading layout whenever it likes — the recipe for jank. `@vectorvesper/motion` gives every effect **one** heartbeat, **one** shared input layer, and a live performance budget they all obey. The core is **zero-dependency** and framework-agnostic; the React adapters are thin hooks on top.

Because one runtime can see every effect at once, it can do something a pile of independent components structurally cannot: **when a frame runs long, it drops the least important work rather than letting everything degrade together.**

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

**React** — predict a hover ~200ms before it lands and pre-warm the expensive thing:

```tsx
import { usePointerIntent } from "@vectorvesper/motion/react";

function PreviewCard() {
  const { ref, intent } = usePointerIntent<HTMLDivElement>({ horizon: 0.5 });
  return (
    <article ref={ref}>
      {intent && <WarmVideoPreview />}     {/* mounts before the cursor arrives */}
      <CardContent />
    </article>
  );
}
```

## What's inside

Every primitive rides the same shared loop and input layer — that coordination is the point.

| Primitive | React hook | What it does |
| --- | --- | --- |
| **FrameConductor** | — | One `rAF` loop for the page, three ordered lanes (`input → update → render`), zero idle cost. |
| **SensorBus** | `useSensorBus` | One set of pointer / scroll / viewport listeners, with damped velocity, shared by every reader. |
| **AnimationBudget** | `useAnimationBudget` | Live frame-headroom governor → a stable quality tier (`high` / `medium` / `low`). |
| **AdaptiveQuality** | `useAdaptiveQuality` | A conservative device floor fused with the live budget — consume the worse of the two. |
| **PointerIntent** | `usePointerIntent` | Predicts the pointer is *coming* to an element before it hovers, from velocity. |
| **MagneticElement** | `useMagneticIntent` | A magnetic pull toward the cursor. |
| **VideoScrubber** | `useVideoScrubber` | Drive a video timeline from scroll or pointer. |
| — | `useSafeToMount` | Mount an expensive subtree only once there's real frame headroom. |
| — | `useLazyScene` | Defer a heavy scene until it's in view / the page is idle. |
| — | `useImageTrail` | A trail of images that follows the pointer. |
| — | `useNumberTicker` | Animate a number to its target. |

Plus math utilities: `damp`, `clamp01`, `rayRectIntersect`.

## Why one runtime

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

Subscribers declare what they are, and the runtime spends the frame accordingly:

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

The runtime's value is invisible until you can watch it. `@vectorvesper/motion/devtools` answers the question no component library can:  **which effect on this page is eating the frame?**

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
import { useSensorBus, usePointerIntent } from "@vectorvesper/motion/react";

// devtools — the live runtime inspector
import { mountDevtools } from "@vectorvesper/motion/devtools";
```

Ships **ESM + CJS + TypeScript types**, and resolves under modern *and* classic module resolution — so it works in Vite, esbuild, Next.js, and Framer's code editor alike.

## Documentation

Guides, the full API reference, and live interactive labs for every primitive:

**→ [vectorvesper.dev](https://vectorvesper.dev)**

## License

[MIT](./LICENSE) © Vector Vesper
