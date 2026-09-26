<div align="center">

# @vectorvesper/motion

**An open-source runtime for WebGL, three.js and motion on the web.**

One frame loop for the whole page, quality that follows the device,
and scenes that come back when the browser takes the GPU away.

[![npm](https://img.shields.io/npm/v/@vectorvesper/motion?color=2B6069&label=npm)](https://www.npmjs.com/package/@vectorvesper/motion)
[![CI](https://github.com/vectorvesper/motion-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/vectorvesper/motion-runtime/actions/workflows/ci.yml)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-2B6069)
![types: included](https://img.shields.io/badge/types-included-2B6069)

[Documentation](https://vectorvesper.dev/runtime) · [Changelog](./CHANGELOG.md) · [vectorvesper.dev](https://vectorvesper.dev)

</div>

```bash
npm install @vectorvesper/motion
```

## Why it exists

Rendering failures rarely throw. A scene mounts while the reader is still
scrolling, and the page hitches. The browser takes the GPU away, and the canvas
stays black with nothing in the console. A hero keeps drawing after it has
scrolled out of view, and every frame it spends is taken from whatever is on
screen. None of this fails a test or turns a type red. It produces a page that
is slightly worse, on someone else's machine.

This runtime is the layer underneath the motion that deals with that class of
problem. It decides when work runs, at what quality, and whether it should run
at all, and it shows you where the frame actually went. We built it for WebGL
and three.js scenes first, where a missed frame or a lost context costs the
most. Scroll, pointer, canvas and DOM work run on the same scheduler.

Measured on real pages:

| | Without the runtime | With it |
| --- | --- | --- |
| **Frame cost** | A layout read in the write lane forced a recalculation every frame: about 46ms on one page. | Reads and writes run in separate lanes. The runtime's own work on that page measured 2.4ms. |
| **A second scene** | Below a hero that never stopped drawing, the next scene took 4.5 to 7.5 seconds to appear. | The hero stops drawing off screen, and the next scene arrived in 0.8 seconds. |
| **Quality changes** | Rebuilding the renderer on every change took one page from 3 graphics contexts to 7 in 20 seconds. | Quality is applied to the renderer that is already running. Nothing is torn down. |

It has no dependencies, and every peer is optional.

## Quick start

### A React Three Fiber scene

```tsx
"use client";

import { Canvas } from "@react-three/fiber";
import { useSceneGate } from "@vectorvesper/motion/react";
import { useRenderQuality } from "@vectorvesper/motion/r3f";

export function Hero() {
  const { ref, state, mounted, quality, generation } = useSceneGate<HTMLDivElement>({
    label: "hero",
    cost: "heavy",
  });

  const canvas = useRenderQuality(state, {
    full: { dpr: 2, shadows: true },
    reduced: { dpr: 1, shadows: false },
  });

  return (
    <div ref={ref} style={{ height: "100vh" }}>
      {mounted ? (
        <Canvas key={generation} {...canvas}>
          <HeroScene detail={quality} />
        </Canvas>
      ) : (
        <img src="/hero.jpg" alt="" />
      )}
    </div>
  );
}
```

- **`useSceneGate`** mounts the scene once it is near the viewport and the
  page can afford it. It pauses the scene off screen and picks `full` or
  `reduced` quality from the device and the live frame budget. Under reduced
  motion, or on a device below the floor, it never mounts, and the still image
  stays.
- **`useRenderQuality`** applies that decision to the canvas: pixel ratio,
  shadows, and a frame loop that stops while the scene is off screen. A
  profile's `dpr` is a ceiling, never above the screen's own ratio.
- **`key={generation}`** is what brings the scene back. A lost WebGL context
  can be replaced but never revived, so the gate hands out a new generation and
  the canvas remounts.

### Plain three.js

```tsx
"use client";

import * as THREE from "three";
import { useThreeScene } from "@vectorvesper/motion/three";

export function Hero() {
  const { ref, mounted } = useThreeScene({
    label: "hero",
    renderer: () => new THREE.WebGLRenderer({ antialias: true }),
    setup({ width, height }) {
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
      camera.position.z = 4;

      const knot = new THREE.Mesh(
        new THREE.TorusKnotGeometry(1, 0.3, 128, 16),
        new THREE.MeshNormalMaterial(),
      );
      scene.add(knot);

      return {
        scene,
        camera,
        update: ({ dt }) => {
          knot.rotation.y += dt * 0.5;
        },
        resize: (w, h) => {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        },
      };
    },
  });

  return (
    <div ref={ref} style={{ height: "100vh" }}>
      {!mounted && <img src="/hero.jpg" alt="" />}
    </div>
  );
}
```

You make the renderer and build the scene. `useThreeScene` does the rest:

- gates the build
- draws on the shared loop, and only while the scene is on screen
- caps the pixel ratio
- rebuilds after a lost context
- frees every GPU resource when the scene goes
- never builds under reduced motion

A `WebGPURenderer` works the same way.

### Anything else on the shared loop

```tsx
"use client";

import { useRef } from "react";
import { useTick } from "@vectorvesper/motion/react";

export function Follower({ target }: { target: number }) {
  const el = useRef<HTMLDivElement>(null);
  const x = useRef(0);

  useTick(
    "render",
    (dt) => {
      x.current += (target - x.current) * (1 - Math.exp(-18 * dt));
      if (el.current) el.current.style.transform = `translate3d(${x.current}px, 0, 0)`;
    },
    { priority: "enhanced", label: "Follower" },
  );

  return <div ref={el} />;
}
```

`useTick` joins the page's one `requestAnimationFrame` loop instead of starting
another. It runs outside React's render, reads the latest props without
resubscribing, yields under load according to its priority, and unsubscribes
when the component unmounts. `dt` is in seconds.

## Do you need it?

One animated element does not. It runs fine on its own loop, and a single
canvas can handle its own context loss in about fifteen lines:

```tsx
function Scene() {
  const [generation, setGeneration] = useState(0);

  return (
    <Canvas
      key={generation}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", (event) => {
          event.preventDefault(); // without this, the browser allows no replacement
          setGeneration((g) => g + 1);
        });
      }}
    />
  );
}
```

If that is your page, write those lines and skip the dependency.

The line is roughly where you stop being able to reason about your canvases one
at a time. At five effects, they compete for the same 16.7 milliseconds and
none of them knows the others exist. Each one starts its own loop, and each
loop reads layout and then writes it, so the browser can end up recalculating
layout once per effect, every frame.

At a dozen canvases, the arithmetic changes again. A lost context is usually
not about that canvas. Browsers keep around sixteen live contexts per page and
drop the oldest when another is requested, which is often the hero. One counter
that every scene reads rebuilds the page coherently, where a dozen components
each asking for a new context make it worse.

## It grows with the page

| When | Add |
| --- | --- |
| You want one nice effect | an effect hook |
| Now you have five of them | `useTick` on the shared conductor |
| One of them is a 3D scene | `useSceneGate` |
| Fine on your laptop, struggling on a phone | `useAdaptiveQuality` |
| Something is slow and you cannot tell what | `mountDevtools`, then `useFramePressure` |

## What's inside

| Import | For | Main exports |
| --- | --- | --- |
| `@vectorvesper/motion` | Any framework, or none. Safe to import on a server. | `getConductor`, `getSensorBus`, `getAnimationBudget`, `getAdaptiveQuality`, `getFramePressure`, `getRendererHealth`, `watchGPUDevice` |
| `@vectorvesper/motion/react` | React | `useTick`, `useSceneGate`, `useSafeToMount`, `useAdaptiveQuality`, and the hooks below |
| `@vectorvesper/motion/r3f` | React Three Fiber | `useRenderQuality` |
| `@vectorvesper/motion/three` | Plain three.js in React | `useThreeScene` |
| `@vectorvesper/motion/devtools` | A live overlay while you develop | `mountDevtools` |

The adapters import nothing from `three` or `@react-three/fiber` at runtime.

### Core primitives

| Primitive | React hook | What it does |
| --- | --- | --- |
| FrameConductor | `useTick` | The one `requestAnimationFrame` loop for the page, with three ordered lanes (`input`, `update`, `render`) and no cost while idle. |
| SensorBus | `useSensorBus` | One set of pointer, scroll and viewport listeners for the whole page, with damped velocity, shared by every reader. |
| AnimationBudget | `useAnimationBudget` | A live quality tier from measured frame health, so effects can shed themselves. |
| FramePressure | `useFramePressure` | Names which of three unrelated things is eating the frame (this runtime, other main-thread work, or rendering) and how sure it is. |
| AdaptiveQuality | `useAdaptiveQuality` | Device capability, live frame health and the reduced-motion preference, fused into one quality signal. |
| RendererHealth | used by the adapters | Notices a lost graphics context and counts a generation to remount on. |
| `watchGPUDevice` | used by the adapters | The same for a WebGPU device, which reports its loss through `device.lost` rather than an event. A device you destroy yourself is not treated as a loss. |

A hand-built renderer reports a loss with `getRendererHealth().reportLost({ builtAt })`,
passing the generation it was built under, and calls `reportHealthy()` once the
replacement draws. `useRenderQuality` and `useThreeScene` do this for you.

### React hooks

| Hook | What it does |
| --- | --- |
| `useSafeToMount` | Mounts an expensive subtree only once there is real frame headroom. |
| `useSceneGate` | One policy for a heavy scene: when to mount it, whether to draw, at what quality, and how to come back from a lost context. With `content: true` it holds a heavy section, such as a chart, the same way, but still mounts it under reduced motion. |
| `InteractionScope` | Marks the region the visitor is working in. While a pointer is down inside it, non-essential work outside yields earlier. |
| `usePointerIntent` | Predicts that the pointer is heading for an element before it arrives, for prefetching on desktop. |
| `useMagneticIntent` | A magnetic pull towards the cursor. |
| `useVideoScrubber` | Drives a video's timeline from scroll or pointer. |
| `useNumberTicker` | Animates a number to its target, written straight to the DOM. |
| `useImageTrail` | A trail of images following the pointer, from a recycled pool. |

Plus maths helpers: `damp`, `clamp01`, `scrollProgress` and `rayRectIntersect`.

## Scheduling

Subscribers declare what they are, and the loop spends each frame accordingly:

```ts
getConductor().subscribe("render", draw, {
  priority: "decorative", // "essential" | "enhanced" | "decorative"
  hz: 30,                 // optional cadence cap
  label: "AuroraBackground", // shown in the devtools overlay
});
```

| Priority | For | Shed when |
| --- | --- | --- |
| `essential` | Sensors, governors, direct manipulation | Never |
| `enhanced` | Interaction feedback (the default) | The frame is about 70% spent |
| `decorative` | Ambient detail | The frame is about 45% spent |

Shedding is per frame, and nothing starves. A subscriber skipped four frames
running is forced through, so a heavy page runs its decorative work at a lower
cadence instead of freezing it. The budget follows the display's measured
refresh rate, not an assumed 60Hz.

Because reads (`input`) run before writes (`render`), the browser recalculates
layout at most once per frame, however many effects subscribe.

## Quality that knows why

Lowering quality only fixes one kind of slow. If a third-party script is
blocking the main thread, halving your particle count makes the page uglier and
exactly as slow.

So `useAdaptiveQuality` reads the pressure classifier. It lowers quality for
rendering pressure and for a weak device, and it refuses for a blocked main
thread, reporting that refusal as `cause: "held"`.

```ts
const { tier, label, cause } = useAdaptiveQuality();
// label: "high" | "medium" | "low"
// cause: "ok" | "device" | "reduced-motion" | "render" | "frame-rate" | "held"
```

One limit worth knowing: the classifier stays quiet on frames less than 25%
over budget, roughly 48fps at 60Hz. A page dipping to 55fps on the GPU reads as
no pressure, and the budget tier covers that band. The classifier diagnoses
frames that are properly blown. It is not a general render-pressure detector.

## Without React

The core entry has no React import and no `"use client"` directive, so it can
be imported anywhere, including on a server. Nuxt, SvelteKit and Astro all
render without a DOM, and the runtime returns its defaults there rather than
throwing.

You write the same code React does, in your framework's lifecycle hooks: in
Vue, `onMounted` and `onUnmounted`; in Svelte, `onMount` and its returned
cleanup.

```js
import { getConductor, getSensorBus } from "@vectorvesper/motion";

// Vue
onMounted(() => {
  const release = getSensorBus().retain();
  const off = getConductor().subscribe("render", () => {
    const { x } = getSensorBus().state.pointer;
    el.value.style.transform = `translate3d(${x * 0.05}px, 0, 0)`;
  });
  onUnmounted(() => {
    off();
    release();
  });
});
```

The hooks in `/react` depend on React. Outside it, you get the engine and wire
the lifecycle yourself, which is roughly fifteen lines per effect.

## Tested in real browsers

We build every release into a real site and run it through our browser lab in
Chrome and Safari's engine, on desktop and mobile profiles. The probes take the
GPU away, scroll scenes off screen, load the device and turn on reduced motion.
What they find goes into the [changelog](./CHANGELOG.md) with its measurement.
Unit tests, type checks and a frozen API surface run in CI on every push to
`main` and every pull request.

| | Supported | Tested with |
| --- | --- | --- |
| React | 18 and later | 19 |
| React Three Fiber | 8 and later | 9 |
| three.js | r150 and later | r182 to r186 |

All three are optional peers. Server rendering needs Node 18 or later.

## Build on it

Most [Vector Vesper components](https://vectorvesper.dev/components) run on
this runtime, and you can build your own on it too. The `vectorvesper` CLI sets
up a project, and its MCP server works in Cursor, Claude and Windsurf. Your
agent plans against the runtime's contracts and checks its work with
`check_motion`: 21 rules for motion code that compiles cleanly and still ships
a bad page.

```bash
npx vectorvesper init
npx vectorvesper mcp install
```

[CLI](https://vectorvesper.dev/docs/cli) · [MCP server](https://vectorvesper.dev/docs/mcp) · [check_motion rules](https://vectorvesper.dev/docs/check-motion)

## Upgrading

- **From 3.x:** in 4.0, `useRenderQuality` changed to return props you spread
  onto `<Canvas>`. See [4.0.0 in the changelog](./CHANGELOG.md#400).
- **From 2.x:** see [MIGRATION-3.0.md](./MIGRATION-3.0.md).

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md). Please report security problems
privately, as described in [SECURITY.md](./SECURITY.md).

## License

[Apache 2.0](./LICENSE) © Vector Vesper

Up to and including 4.2.0 the runtime was MIT. That grant stands: if you hold
one of those versions, your rights under MIT do not change. Apache 2.0 applies
from 4.3.0 onward, and adds an express patent grant, patent retaliation, and an
explicit statement that the licence conveys no trademark rights.
