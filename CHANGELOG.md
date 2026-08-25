# Changelog

## 2.0.1

Two fixes found by porting a real R3F gallery onto 2.0 rather than reading the
types and assuming.

### Fixed

- **`useSceneGate` never started if its ref target was not in the DOM on the
  first commit.** The observer effect read `ref.current` once, keyed on
  `[preload]`, so a component that renders a spinner, a Suspense fallback or a
  `next/dynamic` placeholder before its real tree attached no
  `IntersectionObserver` at all — and nothing re-ran the effect when the
  element finally arrived. The scene stayed `dormant` permanently, with no
  error and no warning to explain it. Since almost every R3F component guards
  SSR that way, this hit the common case rather than an edge one.

  The ref is now a hybrid callback ref, the same one `usePointerIntent` has
  always used, so it re-arms when the element attaches. `SceneGate.ref` is
  still a `RefObject<T | null>` and `<div ref={gate.ref}>` is unchanged — this
  is a fix, not an API change.

- **A scene reduced by render pressure blamed the wrong thing.** `decide()`
  tested `tier === 1` before the render-pressure branch, and rendering being
  the bottleneck is precisely what drags the tier down — so both were true
  together and the generic "the frame rate is not holding up" always won.
  The sentence written for this exact case was unreachable in practice.
  Render pressure is now tested first. The state was correct before and is
  unchanged; only the reported reason improves.

Four tests cover both, including the deferred-ref mount that the first bug
made permanently dormant.

## 2.0.0

Phase 2 of the runtime. The package can now say **what** is costing a frame,
decide whether a heavy scene should run at all, survive a lost graphics
context, and its entry points finally match its layers:

```
@vectorvesper/motion            kernel + health
@vectorvesper/motion/react      + scene policy
@vectorvesper/motion/r3f        renderer adapter
@vectorvesper/motion/effects    recipes
@vectorvesper/motion/devtools   proof
```

Breaking, but mechanically so. Every change below is a rename or a moved
import — nothing needs redesigning.

### Migrating

**Five effects hooks moved off `/react`.** Nothing was removed; the import
path changed. Their option types moved with them.

```diff
- import { usePointerIntent, useImageTrail } from "@vectorvesper/motion/react";
+ import { usePointerIntent, useImageTrail } from "@vectorvesper/motion/effects";
```

Affects `usePointerIntent`, `useMagneticIntent`, `useImageTrail`,
`useNumberTicker`, `useVideoScrubber`.

**Three names changed.** They collided with the libraries this package sits
next to — `useMotionFrame` stood beside Motion's `useAnimationFrame` and R3F's
`useFrame`, three near-identical names for "run this every frame" in one file.

| 1.2 | 2.0 |
| --- | --- |
| `MotionScope` | `InteractionScope` |
| `useMotionFrame` | `useTick` |
| `useMotionScope` | `useInteractionScope` |

`InteractionScope`'s props changed with the rename. The common case is now
zero props — ids are generated with `useId()` instead of a hand-written
page-unique `name`.

| 1.2 | 2.0 |
| --- | --- |
| `name` (required) | gone — generated |
| — | `label` (optional, devtools only) |
| `claimOnPointer={false}` + manual `claimScope` | `active` |
| `as` | `asChild` |
| `useMotionFrame(..., { scope: null })` | `useTick(..., { background: true })` |

**`useLazyScene` is gone.** `useSceneGate` does everything it did. It takes the
same options, and `ready` is now `mounted`:

```diff
- const { ref, ready } = useLazyScene({ preload: 300, cost: "heavy" });
+ const { ref, mounted } = useSceneGate({ preload: 300, cost: "heavy" });
```

Three hooks gated a mount, which was one too many — and `cost` meant two
unrelated things depending on which one you passed it to. `useSceneGate` now
owns the visibility observer directly and asks `useSafeToMount` whether the
page can afford the work, so there is one definition of that instead of two
that disagreed.

**Option fields renamed.** No exports removed.

| Hook | 1.2 | 2.0 |
| --- | --- | --- |
| `useSafeToMount` | `minHeadroomMs`, `requiredCleanFrames`, `minCores` | `cost: "light" \| "normal" \| "heavy"` |
| `usePointerIntent` | `horizon`, `extend`, `minSpeed`, `enter`, `exit` | `sensitivity: "low" \| "normal" \| "high"` |
| `useNumberTicker` | `k` | `speed` |
| `useImageTrail` | `life` | `duration` |
| `useVideoScrubber` | `smooth` | `speed` |
| `MagneticOptions` | `damp` | `speed` |
| `MagneticOptions` | `intent` | `anticipate` |

`useVideoScrubber`'s `smooth` was inverted — a *lower* number produced *more*
smoothing, and its own JSDoc stated the opposite of the truth. `speed` reads
the way you would guess.

### Added

- **`getFramePressure` / `useFramePressure`** — names what is eating the frame:
  this runtime, other main-thread work, or rendering. It reports a confidence
  alongside the verdict, and refuses to claim a GPU reading it cannot take —
  `offThreadMs` is a remainder, not a measurement.
- **`useSceneGate`** — one policy for a heavy scene across seven states
  (`dormant`, `warming`, `active`, `constrained`, `idle`, `recovering`,
  `poster`): when to mount it, whether to run it, at what quality, and how to
  bring it back from a lost context.
- **`getRendererHealth`** — a lost graphics context leaves a permanently black
  canvas and no console error, because R3F has no handler for it (verified
  against 9.6.1). Recovery is a generation counter: put it on `<Canvas key>`
  and React rebuilds the scene it already knows how to build.
- **`@vectorvesper/motion/r3f`** — `useRenderQuality` applies a scene gate's
  decision to the renderer: device pixel ratio and shadow maps, and nothing it
  cannot genuinely apply.
- **`SAFE_TO_MOUNT_COST`**, `MountCost`, `MountCostThresholds`,
  `PointerIntentSensitivity` — exported so a component can name these types in
  its own props.
- **`SubscriberStat.scope`** — shows which work is protected while a region is
  active.

### Fixed

- **The refresh-rate probe was wrong on an ordinary 60Hz laptop**, so the frame
  budget it derived was wrong with it.
- **A stopped loop remembered it was struggling.** Carried overrun survived a
  stop, so the first frame after a restart began already in debt.
- **`MagneticElement` read `anticipate` only in its constructor**, so toggling
  it after mount silently did nothing — and `useMagneticIntent` never forwarded
  the option at all.
- **`SensorBus` reported movement it never saw**, and `dt` is now floored.


## 1.2.0

**Priority shedding now actually fires.** It never had.

The shed decision compared only this runtime's own elapsed work against the
frame budget. That made it unreachable in the normal case: when React, style,
layout, paint or the GPU are what is eating the frame, our subscribers might
total 3ms of a 16.6ms budget while the frame lands in 28ms. The conductor
measured 3ms, concluded there was room, and ran everything — on a page visibly
at 29fps, while `headroom` next door already reported -19ms. Two subsystems,
two beliefs about the same frame.

- **Carried overrun.** Each frame now begins already spent by however far the
  previous one overran, taken from the wall clock and capped at one frame
  budget. A frame that landed 11ms late starts 11ms in debt, which pushes
  decorative work past its threshold immediately. The debt rises quickly and
  decays slowly on purpose — symmetric smoothing oscillates, because shedding
  rescues the frame, the debt clears, the work returns, and the frame blows out
  again.
- **`ConductorStats.carriedOverrunMs`** exposes that debt, and the devtools
  overlay shows it as `carried`. Non-zero means something outside this runtime
  is eating the frame, and it is why low-priority work is being dropped.
- **`essential` is unaffected.** Its threshold is still infinite, so sensors,
  governors and direct manipulation can never be shed however deep the debt.

Measured on a reference harness — 24 subscribers, 0.6ms of synthetic work each,
identical code in both modes with only the shedding flag changed:

| | fps | p95 frame | worst frame |
|---|---|---|---|
| shedding on | 60 | 17.5ms | 29.6ms |
| shedding off | 30 | 35.7ms | not comparable* |

At heavier load (80 subscribers, 3ms each) the same comparison ran at 14fps
against 4-5fps. These are synthetic subscribers measured on one machine, not a
benchmark suite. *The shedding-off run was interrupted by a multi-second
background stall, so its worst-frame figure measures the interruption rather
than the page.

**Motion scopes — a foreground lease for interaction.** Priorities are a fixed
statement about what work is worth. A scope is a live statement about where
attention is right now.

```tsx
<MotionScope name="gallery">
  <Gallery />
</MotionScope>
```

While a scope holds the lease, every subscriber outside it sheds one band
earlier — `enhanced` behaves as `decorative`, `decorative` yields sooner still.
So the ambient scene in the corner gives up its frame time to the gallery being
dragged, and takes it back on release. `essential` is exempt either way, and
the starvation guard still applies, so a held lease cannot freeze background
work.

Everything rendered inside the provider joins the scope, and a pointer down
inside it takes the lease. The name is therefore written once: a scope repeated
by hand at each subscription can disagree with itself, and a mismatched name
fails silently rather than loudly.

**`useMotionFrame`** subscribes to the loop from a component, inheriting that
scope from the tree. It also holds the callback in a ref, so a frame function
can close over current props without resubscribing on every render — doing that
by hand churns the lane arrays and resets each subscriber's cost average.

`ConductorStats.activeScope` and the devtools `foreground` tile report who
holds the lease. `getConductor().claimScope(name)` remains available for
imperative and non-React use.

**Priorities swept.** Every non-essential subscriber previously declared
`enhanced`, so the `decorative` band went unused and degradation was binary
rather than graduated. `PointerIntent`, `useNumberTicker` and the
`usePointerIntent` mirror now declare `decorative`.

**The devtools overlay is `decorative`, not `essential`.** Measured under CPU
throttling it was the most expensive subscriber on the page, so privileging it
meant shedding the content in order to keep alive the readout about the
content. It cannot vanish: the starvation guard forces any subscriber through
after a few skipped frames, so under heavy load it degrades from 5Hz to roughly
3Hz rather than stopping.

## 1.1.2

Restored the `"use client"` directive on the React and devtools bundles, which
esbuild had been stripping since 1.0. A build step re-applies it from the source
file after bundling, so it cannot drift again. 1.1.0 and 1.1.1 were published on
the way to this fix and are superseded by it.

`entry.react.ts` re-binds core values as local constants rather than
re-exporting them, so the React entry no longer resolves through a shared chunk.

## 1.0.2

Packaging only. No API change, no behaviour change — the public surface is
identical and still guarded by `api-surface.json`.

- **Sourcemaps are no longer published.** Every `.map` embedded `sourcesContent`,
  so the tarball carried roughly 112 KB of the original commented TypeScript —
  the whole engine, source comments included. Debugging convenience is not worth
  shipping the source, so the maps are gone.
- **The bundle is minified.** The previous build kept `// src/core/<file>.ts`
  banners above each section, which made the published artifact read like the
  repository. Minifying does not make anything secret — code that runs in a
  browser can always be read — it just means the package is a compiled artifact
  rather than a copy-paste-ready source drop.
- **Private class members are stripped from the type declarations.** TypeScript
  emitted every private field by name (`private frameMsEma;`,
  `private prevPointerX;`, …), documenting the internals of `FrameConductor`,
  `SensorBus` and `AnimationBudget`. Each run is now replaced with TypeScript's
  own `#private;` brand, which keeps the classes nominally typed while publishing
  nothing about their state. Public members, and their documentation, are
  unchanged.

Net effect: 591 KB unpacked across 36 files → 169 KB across 26.

## 1.0.0

The public API is frozen.

Nothing consumers actually use changed — the ten React hooks, the four singleton
accessors (`getConductor`, `getSensorBus`, `getAnimationBudget`,
`getAdaptiveQuality`) and the pure helpers (`damp`, `clamp01`,
`rayRectIntersect`) are exactly as they were. What changed is what the package
_stops_ exporting, so that the surface it now commits to supporting is the one
it actually means.

### Removed from the public surface

These were internal machinery that had leaked into the exports. None were used
by the hooks or documented for consumers; they remain in the codebase, just no
longer part of the published API.

- Refresh-rate internals: `RefreshRateProbe`, `snapToCandidate`,
  `REFRESH_CANDIDATES`, `DEFAULT_HZ`.
- `deviceTierFromSignals` — a test helper.
- The imperative core classes `PointerIntent`, `MagneticElement`,
  `VideoScrubber`, `SensorBus` (as a constructor) and `BudgetPolicy`. Drive
  these through the React hooks, which own their lifecycle. `SensorBus` remains
  exported as a **type** (it's what `getSensorBus()` returns); the option types
  (`PointerIntentOptions`, `MagneticOptions`, `VideoScrubberOptions`, …) all stay.
- `VIDEO_SCRUBBER_DEFAULTS` and `scrollProgress` — scrubber-internal.

### Added

- **API surface guard.** `scripts/check-api.mjs` diffs the built declarations
  against a committed `api-surface.json` and fails the build on any accidental
  change. It runs in `prepublishOnly`, so the frozen surface cannot drift into a
  release unnoticed.

## 0.3.0

The loop became a scheduler.

*(0.2.0 was never published — the version was bumped again before release.
Everything below shipped as 0.3.0.)*

v0.1 shared one `requestAnimationFrame` across every effect, which is tidy but
not much more than housekeeping — every subscriber still ran every frame,
unconditionally, in whatever order it happened to subscribe. This release uses
the fact that one runtime can see the whole page.

### Added

- **Priority scheduling.** `subscribe(lane, fn, { priority, hz, label })`.
  Subscribers declare themselves `essential`, `enhanced` (default) or
  `decorative`; when a frame runs long the runtime drops the least important
  work **for that frame** instead of letting everything degrade together.
  Nothing starves — four consecutive skips forces a subscriber through, so
  heavy pages degrade decorative work to a lower cadence rather than freezing
  it.
- **Cadence caps.** `hz` throttles a subscriber and passes the accumulated
  `dt` through, so frame-rate-independent damping stays correct. An ambient
  layer at 30Hz looks identical and costs half.
- **Per-subscriber attribution.** `getConductor().getStats()` returns a cost
  breakdown, sorted most expensive first. This is free: the scheduler already
  has to read the clock after each subscriber to know how much of the frame is
  left, so there is exactly one `performance.now()` call per executed
  subscriber and the shed decision and the cost table come from the same
  timestamp.
- **`@vectorvesper/motion/devtools`.** `mountDevtools()` — a zero-dependency,
  framework-free shadow-DOM overlay showing fps, frame time, runtime work,
  headroom, tier, and the live per-subscriber cost table. Separate entry
  point, so it only reaches bundles that import it.
- **Display refresh detection.** The runtime measures the real vsync period
  rather than assuming 60Hz. `getConductor().displayHz` / `.frameBudgetMs`.
- **`getConductor().configure({ shedding, onError, slowSubscriberMs })`** —
  scheduling can be turned off entirely, errors can be routed somewhere other
  than the console, and a dev-mode profiler can warn about slow subscribers.
- **`BudgetState.workMs` / `.frameBudgetMs`** — how much of the frame the
  runtime itself is responsible for, and what it is being measured against.
- **`getAnimationBudget().reset()`** — discard the rolling window on SPA route
  changes, so a new scene isn't judged by the frames the previous one produced.

### Fixed

- **`headroom` was measuring the wrong thing.** It was `frameBudget - dt`, and
  because rAF is pinned to vsync, `dt` on a *healthy* 60Hz page is 16.6ms — so
  an idle page reported ~0ms of headroom and the signal was unusable below
  60Hz. In particular `useSafeToMount`'s default `minHeadroomMs: 6` was
  unreachable on the most common display in the world. Headroom is now derived
  from measured work while frames land on time, and from the actual overrun
  once they don't.
- **Quality thresholds assumed 60Hz.** A 120Hz display limping at 70fps read
  as perfectly healthy. The slow / very-slow lines are now multiples of the
  measured frame budget. The factors were chosen to reproduce the old absolute
  constants *exactly* at 60Hz, so 60Hz behaviour is unchanged and only
  high-refresh displays start telling the truth.
- **`useSafeToMount` could never open if the page was busy when it mounted.**
  It returned early without subscribing whenever the budget was already at
  tier 1+, so it could not recover without a full remount — exactly backwards,
  since pages are always busy during hydration, which is when this hook
  mounts. It now waits and opens when the page settles.
- **`MagneticElement` thrashed layout.** It called `getBoundingClientRect()`
  in the render lane immediately before writing `transform`, so with two
  magnetic elements on a page the second read was a forced synchronous layout
  — thrash scaling with the number of elements, inside the engine whose whole
  premise is reads-before-writes. Measurement moved to the input lane and the
  anchor is now cached, so the steady state costs no layout reads at all.
- **Conductor error logging no longer floods.** A subscriber throwing every
  frame logged 60 times a second, which made the console useless and hid the
  actual bug. First failure per subscriber is logged, the rest are suppressed.

### Changed

- Subscribers within a lane now run in priority order rather than subscribe
  order. Insertion order is preserved within a priority band, and lane order
  (`input → update → render`) is unchanged.
- The per-frame subscriber-set copy is gone; the hot path no longer allocates.
- Existing two-argument `subscribe(lane, fn)` calls keep working and default to
  `enhanced`. If you want v0.1's unconditional behaviour back:
  `getConductor().configure({ shedding: false })`.

## 0.1.2

- `useMagneticIntent` gated on `(pointer: coarse)`, which disabled it on a
  touchscreen laptop that also had a mouse. Now uses `(any-pointer: fine)`.

## 0.1.0

Initial public release — FrameConductor, SensorBus, AnimationBudget,
AdaptiveQuality, PointerIntent, MagneticElement, VideoScrubber and the React
adapters.
