<div align="center">

# @vectorvesper/motion

**Motion primitives on one shared frame loop.**
A sensor layer, a frame-budget governor, and React hooks that share a single `requestAnimationFrame` loop.

[![npm](https://img.shields.io/npm/v/@vectorvesper/motion.svg?color=8b5cf6)](https://www.npmjs.com/package/@vectorvesper/motion)
![zero dependencies](https://img.shields.io/badge/dependencies-0-10b981)
![types included](https://img.shields.io/badge/types-included-38bdf8)
[![license](https://img.shields.io/badge/license-MIT-a3a3a3)](./LICENSE)

</div>

---

A set of small, composable motion primitives that share one heartbeat instead of each spinning up its own `requestAnimationFrame` loop and listeners. One loop, one input layer, and a live frame budget every effect obeys — so motion stays coordinated and smooth as a page grows.

The core is zero-dependency and framework-agnostic. The React hooks are thin adapters on top. Free and MIT.

## Install

```bash
npm install @vectorvesper/motion
```

React hooks need `react` and `react-dom` (>=18) as peers. The core needs nothing.

## Quick start

**Core** — works anywhere (vanilla, Vue, Svelte, Framer). One shared loop, frame-rate-independent smoothing:

```ts
import { getConductor, damp } from "@vectorvesper/motion";

let x = 0;
const off = getConductor().subscribe("render", (dt) => {
  x = damp(x, targetX, 12, dt);
  el.style.transform = `translate3d(${x}px, 0, 0)`;
});
// off() to unsubscribe — the loop sleeps when its last subscriber leaves.
```

**React** — render the expensive version only on hardware that can hold the frame:

```tsx
import { useAdaptiveQuality } from "@vectorvesper/motion/react";

function Hero() {
  const { tier } = useAdaptiveQuality();   // device floor fused with the live frame budget
  return tier === 0 ? <ShaderBackground /> : <StaticGradient />;
}
```

`tier` degrades on a struggling device and recovers when the page settles, so the same code ships a rich experience to a desktop and a calm one to a mid-range phone.

## What's inside

**Core** — `@vectorvesper/motion`. Zero dependencies, no framework.

| Primitive | React hook | What it does |
| --- | --- | --- |
| FrameConductor | `useTick` | One `rAF` loop for the page, three ordered lanes (`input → update → render`), zero idle cost. |
| SensorBus | `useSensorBus` | One set of pointer / scroll / viewport listeners, with damped velocity, shared by every reader. |
| AnimationBudget | `useAnimationBudget` | Live frame-headroom governor → a stable quality tier (`high` / `medium` / `low`). |
| AdaptiveQuality | `useAdaptiveQuality` | A device floor fused with the live budget — consume the worse of the two. |
| FramePressure | `useFramePressure` | Names what is costing the frame: this runtime, other main-thread work, or rendering. |
| RendererHealth | — | Notices a lost graphics context and counts a recovery generation to remount on. |

**Scene policy** — `@vectorvesper/motion/react`. Decide whether expensive work runs at all.

| React hook | What it does |
| --- | --- |
| `useSafeToMount` | Mount an expensive subtree only once there's real frame headroom. |
| `useSceneGate` | One policy for a heavy scene — when to mount it, whether to run it, at what quality, and how to bring it back from a lost context. |
| `InteractionScope` | Mark the region the visitor is working in. While a pointer is down inside it, non-essential work *outside* the region yields earlier. |

**Effects** — `@vectorvesper/motion/effects`. Self-contained. Reach for one when you want the specific thing it does.

| React hook | What it does |
| --- | --- |
| `usePointerIntent` | Predicts the pointer is heading for an element before it hovers — for pre-fetching on desktop. |
| `useMagneticIntent` | A magnetic pull toward the cursor. |
| `useVideoScrubber` | Drive a video timeline from scroll or pointer. |
| `useNumberTicker` | Animate a number to its target, written straight to the DOM. |
| `useImageTrail` | A trail of images that follows the pointer. |

**React Three Fiber** — `@vectorvesper/motion/r3f`.

| React hook | What it does |
| --- | --- |
| `useRenderQuality` | Apply a scene gate's decision to the renderer — device pixel ratio and shadow maps. |

Plus math utilities: `damp`, `clamp01`, `rayRectIntersect`.

## Scheduling

Subscribers declare what they are, and the loop spends each frame accordingly:

```ts
getConductor().subscribe("render", draw, {
  priority: "decorative",   // "essential" | "enhanced" | "decorative"
  hz: 30,                   // optional cadence cap
  label: "AuroraBackground" // shown in devtools
});
```

| Priority | For | Shed when |
| --- | --- | --- |
| `essential` | Sensors, governors, direct manipulation | Never |
| `enhanced` | Interaction feedback *(default)* | Frame is ~70% spent |
| `decorative` | Ambient garnish | Frame is ~45% spent |

Shedding is per frame, and nothing starves — a subscriber skipped four frames running is forced through, so heavy pages degrade decorative work to a lower cadence instead of freezing it. The budget tracks the measured display refresh rate, not an assumed 60Hz.

Because reads (`input`) run before writes (`render`), the browser recomputes layout at most once per frame, however many effects subscribe.

## Devtools

A separate entry point that shows which effect is spending the frame:

```ts
import { mountDevtools } from "@vectorvesper/motion/devtools";

if (process.env.NODE_ENV !== "production") mountDevtools();
```

```
60fps    frame 16.7ms   work 2.14ms
headroom 12.4ms   tier 0 high   shed/frame 0

  Sparkles          render   4.00
  MagneticElement   render   2.00
  SensorBus         input    1.00

3 subscribers · 1 rAF loop · 60Hz display (16.7ms budget)
```

A live table of every subscriber with its lane and per-frame cost in milliseconds, priority shown by colour. It's a DOM function with no framework dependency — call it from a React effect, a Vue `onMounted`, or the console. Renders into a shadow root, refreshes at 5Hz.

## Entry points

```ts
// core — zero-dep, framework-agnostic
import { getConductor, getSensorBus, damp } from "@vectorvesper/motion";

// react — hooks (react + react-dom peers)
import { useSensorBus, useAdaptiveQuality } from "@vectorvesper/motion/react";

// effects — self-contained visual effects, not runtime
import { useImageTrail, useNumberTicker } from "@vectorvesper/motion/effects";

// r3f — the React Three Fiber adapter (three + @react-three/fiber optional peers)
import { useRenderQuality } from "@vectorvesper/motion/r3f";

// devtools — the live inspector
import { mountDevtools } from "@vectorvesper/motion/devtools";
```

The core entry is framework-agnostic and safe to import from a server. Every
other entry declares `"use client"`.

Ships ESM + CJS + TypeScript types, resolving under modern and classic module resolution — Vite, esbuild, Next.js, and Framer's code editor.

## Documentation

Guides, the full API reference, and interactive labs for every primitive:

**→ [vectorvesper.dev](https://vectorvesper.dev)**

## License

[MIT](./LICENSE) © Vector Vesper
