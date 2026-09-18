<div align="center">

# @vectorvesper/motion

**Frame-time discipline for WebGL, canvas, and scroll-driven pages.**

*For the failures that never throw.*

[![npm](https://img.shields.io/npm/v/@vectorvesper/motion.svg?color=8b5cf6)](https://www.npmjs.com/package/@vectorvesper/motion)
![zero dependencies](https://img.shields.io/badge/dependencies-0-10b981)
![types included](https://img.shields.io/badge/types-included-38bdf8)
[![license](https://img.shields.io/badge/license-MIT-a3a3a3)](./LICENSE)

</div>

---

```bash
npm install @vectorvesper/motion
```

Rendering failures rarely throw. A scene mounts while the reader is still
scrolling and the page hitches. A context is lost and the canvas stays black.
Quality flips between tiers twice a second. Frames take 45ms and nothing tells
you whether the cost is yours, React's, or the compositor's.

None of that produces an error, a failed test, or a red type. It produces a page
that is slightly worse in a way you notice on someone else's machine.

This runtime is a set of primitives for that class of problem: deciding when
work runs, at what quality, whether it should run at all, and being able to see
where the frame actually went.

```tsx
import { useSceneGate } from "@vectorvesper/motion/react";
import { useRenderQuality } from "@vectorvesper/motion/r3f";

export function Scene() {
  const { ref, state, mounted, generation } = useSceneGate<HTMLDivElement>({ cost: "heavy" });
  const quality = useRenderQuality(state, {
    full: { dpr: 2 },
    reduced: { dpr: 1 },
  });

  // `mounted` waits for the page to afford it. `generation` bumps when a context
  // is lost, and keying on it is what replaces the canvas, since a lost context
  // can be recreated but never revived.
  return <div ref={ref}>{mounted && <Canvas key={generation} {...quality} />}</div>;
}
```

## Do you need this?

One animated element does not. It runs fine on its own loop, and a single canvas
can handle its own context loss in about fifteen lines:

```tsx
const [gen, setGen] = useState(0);
<Canvas key={gen} onCreated={({ gl }) => {
  gl.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();          // without this the browser will not let you recreate
    setGen((g) => g + 1);
  });
}} />
```

If that is your page, write those lines and skip the dependency.

The line is roughly where you stop being able to reason about your canvases one
at a time. At five effects they compete for the same 16.7 milliseconds and none
of them knows the others exist. Every library that animates starts its own loop,
and every loop reads layout and then writes it, so ten independent loops means
the browser recalculating layout up to ten times a frame.

At a dozen canvases the arithmetic changes again. A lost context is usually not
about that canvas. Browsers keep around sixteen and evict the oldest when
another is requested, so the loss is the page telling you it asked for too many,
and a dozen components independently re-requesting contexts makes it worse. One
counter that every scene reads rebuilds the page coherently instead.

## It grows with the page

| When | Add |
| --- | --- |
| You want one nice effect | an effects hook |
| Now you have five of them | `useTick` on the shared conductor |
| One of them is a 3D scene | `useSceneGate` |
| Fine on your laptop, dies on a phone | `useAdaptiveQuality` |
| Something is slow and you cannot tell what | `mountDevtools`, then `useFramePressure` |

## What is inside

**Core.** `@vectorvesper/motion`. Zero dependencies, no framework. Works from
vanilla JS, Vue, Svelte, or anything else.

### Using it outside React

The core entry has no React import and no `"use client"` directive, so it can be
imported anywhere, including on a server. Reading a governor or holding the
sensor bus during SSR is safe: Nuxt, SvelteKit and Astro all render without a
DOM, and the runtime returns its defaults rather than throwing.

What you write is the same code React writes, in your framework's lifecycle
hooks. In Vue that is `onMounted` and `onUnmounted`; in Svelte, `onMount` and
its returned cleanup.

```js
import { getConductor, getSensorBus, damp } from "@vectorvesper/motion";

// Vue
onMounted(() => {
  const release = getSensorBus().retain();
  const off = getConductor().subscribe("render", () => {
    const { x } = getSensorBus().state.pointer;
    el.value.style.transform = `translate3d(${x * 0.05}px, 0, 0)`;
  });
  onUnmounted(() => { off(); release(); });
});
```

**The React hooks are React only.** `useSceneGate`, `useSafeToMount`,
`usePointerIntent` and the rest live in `@vectorvesper/motion/react` and depend
on React. Outside React you get the engine and wire the lifecycle yourself,
which is roughly fifteen lines per effect. The scheduling, the shared sensors,
the governors and the effect classes are all available; the convenience layer is
not.

| Primitive | React hook | What it does |
| --- | --- | --- |
| FrameConductor | `useTick` | One `rAF` loop for the page, three ordered lanes (`input → update → render`), zero idle cost. |
| SensorBus | `useSensorBus` | One set of pointer / scroll / viewport listeners, with damped velocity, shared by every reader. |
| AnimationBudget | `useAnimationBudget` | Live frame-headroom governor, giving a stable tier (`high` / `medium` / `low`). |
| AdaptiveQuality | `useAdaptiveQuality` | Device floor, live budget, and what is actually costing the frame, fused into one verdict. |
| FramePressure | `useFramePressure` | Names what is eating a badly blown frame: this runtime, other main-thread work, or rendering. |
| RendererHealth | none | Notices a lost graphics context and counts a recovery generation to remount on. A hand-built renderer reports with `reportLost({ builtAt })`, passing the generation it was created under, and calls `reportHealthy()` once the replacement draws. |
| `watchGPUDevice` | none | The same, for WebGPU. A device announces its death by resolving `device.lost` rather than firing an event, so it needs its own wiring — and a device you destroyed on purpose is not one that needs replacing. |
| PointerIntent · MagneticElement · VideoScrubber | see below | The engines behind the effects, for use without React. |

**React.** `@vectorvesper/motion/react`. Everything above, plus:

| Hook | What it does |
| --- | --- |
| `useSafeToMount` | Mount an expensive subtree only once there is real frame headroom. |
| `useSceneGate` | One policy for a heavy scene: when to mount it, whether to draw, at what quality, and how to come back from a lost context. With `content: true` it holds a heavy section, such as a chart, the same way but still mounts it under reduced motion. |
| `InteractionScope` | Mark the region the visitor is working in. While a pointer is down inside it, non-essential work outside yields earlier. |
| `usePointerIntent` | Predicts the pointer is heading for an element before it arrives, for prefetching on desktop. |
| `useMagneticIntent` | A magnetic pull toward the cursor. |
| `useVideoScrubber` | Drive a video timeline from scroll or pointer. |
| `useNumberTicker` | Animate a number to its target, written straight to the DOM. |
| `useImageTrail` | A trail of images following the pointer, from a recycled pool. |

**React Three Fiber.** `@vectorvesper/motion/r3f`. `useRenderQuality` applies a
scene gate's decision to the renderer: pixel ratio, shadow maps, stopping the
loop off screen, and surviving a lost context. A profile's `dpr` is a ceiling,
never above the screen's own ratio.

**Plain three.js.** `@vectorvesper/motion/three`. `useThreeScene` is the whole
job in one hook. You make the renderer and build the scene; it gates the
build, draws on the shared loop and only while on screen, sizes the pixel ratio
to the screen, rebuilds after a lost context, frees everything when the scene
goes, and never builds under reduced motion.

```tsx
const { ref, mounted } = useThreeScene({
  renderer: () => new THREE.WebGLRenderer({ antialias: true }),
  setup({ width, height }) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    // ...build the scene
    return { scene, camera, update: ({ dt }) => { /* animate */ } };
  },
});
return <div ref={ref} style={{ height: "100vh" }}>{!mounted && <img src="/hero.jpg" alt="" />}</div>;
```

**DevTools.** `@vectorvesper/motion/devtools`. `mountDevtools()` puts a live
overlay on the page showing per-subscriber cost, what got shed, and how far the
last frame overran. No framework, no dependencies.

Plus maths helpers: `damp`, `clamp01`, `rayRectIntersect`.

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

Shedding is per frame and nothing starves: a subscriber skipped four frames
running is forced through, so heavy pages degrade decorative work to a lower
cadence instead of freezing it. The budget tracks the measured display refresh
rate rather than an assumed 60Hz.

Because reads (`input`) run before writes (`render`), the browser recomputes
layout at most once per frame however many effects subscribe.

## Quality that knows why

Reducing quality only fixes one kind of slow. If a third-party script is
blocking the main thread, halving your particle count makes the page uglier and
exactly as slow.

So `useAdaptiveQuality` reads the pressure classifier and degrades for rendering
pressure and a weak device. It refuses for a blocked main thread and reports
that refusal as `cause: "held"`.

```ts
const { tier, cause } = useAdaptiveQuality();
// cause: "ok" | "device" | "reduced-motion" | "render" | "frame-rate" | "held"
```

One honest limit worth knowing: the classifier stays quiet on frames less than
25% over budget, roughly 48fps at 60Hz. A page dipping to 55fps on the GPU reads
`"none"`, and the budget tier is what covers that band. This is a diagnosis for
frames that are properly blown, and it is not a general render-pressure
detector.

## Entry points

```ts
// Core. No framework, no dependencies.
import { getConductor, getSensorBus, damp } from "@vectorvesper/motion";

// React. Includes everything above.
import { useTick, useSceneGate, usePointerIntent } from "@vectorvesper/motion/react";

// React Three Fiber. Imports nothing from three or R3F at runtime.
import { useRenderQuality } from "@vectorvesper/motion/r3f";

// Plain three.js. Imports nothing from three at runtime either.
import { useThreeScene } from "@vectorvesper/motion/three";

// The live inspector.
import { mountDevtools } from "@vectorvesper/motion/devtools";
```

## Upgrading

Coming from 2.x? See `MIGRATION-3.0.md`, shipped in this package. The short
version is that `/effects` merged into `/react`, `getStats()` became `.state`,
and quality decisions now account for what is actually costing the frame.

## Documentation

[vectorvesper.dev/runtime](https://vectorvesper.dev/runtime)

## License

[MIT](./LICENSE) © Vector Vesper
