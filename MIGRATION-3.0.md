# Migrating to 3.0

Ten changes. Eight are mechanical and the compiler finds them for you. One
changes behaviour with no compile error, and it is the one to read carefully.
An eleventh was proposed and withdrawn; it is kept below as item 2 so the
reasoning is not lost.

Largest single migration in our own catalogue was eleven files.

---

## Read this one first: quality decisions change underneath you

**No code change required. Behaviour changes anyway.**

In 2.x, `AdaptiveQuality` was `max(deviceTier, budgetTier)`. It never looked at
what was actually costing the frame. The rule that reducing quality only helps
when *rendering* is the bottleneck lived inside `useSceneGate` and nowhere else.

So every component calling `useAdaptiveQuality()` directly degraded on frame
rate alone, which means it degraded when a third-party analytics script blocked
the main thread. Making the scene smaller did nothing for that. It made the
page uglier and exactly as slow.

In 3.0 the pressure classifier is folded into the governor. `useAdaptiveQuality`
now answers a better question: *would reducing quality actually help?*

```
2.x   tier = max(deviceTier, budgetTier)
3.0   tier = max(deviceTier, budgetTier), except budgetTier is ignored
            when the frame is provably blocked by something a smaller
            scene cannot fix
```

The device floor is still absolute. When pressure has no verdict, which is any
frame under 25% over budget, tier is trusted exactly as before.

**What you will notice:** components stop dipping to low quality while a heavy
third-party script runs. Twenty-one components in our catalogue were doing that.

**What to check:** anything that reads `tier` and expects it to track frame rate
one-to-one. It now tracks *actionable* slowness. If you genuinely want raw frame
rate, `useAnimationBudget().tier` is unchanged and still gives you that.

---

## Imports

### `/effects` merges into `/react`

```diff
- import { usePointerIntent } from "@vectorvesper/motion/effects";
+ import { usePointerIntent } from "@vectorvesper/motion/react";
```

Affects `usePointerIntent`, `useMagneticIntent`, `useImageTrail`,
`useNumberTicker`, `useVideoScrubber`, `POINTER_INTENT_SENSITIVITY`, and their
option types.

The 2.0 split was justified as "the entries match the layers". In practice
`sideEffects: false` already tree-shakes unused hooks, so a separate entry
bought zero bytes, and both of our own apps immediately wrote a shim collapsing
it back. When every consumer writes the same shim, the shim is the API.

`/r3f` and `/devtools` stay separate, because those protect you from a real
dependency and from bundle weight you have not asked for.

### `/react` picks up two symbols it was missing

`getFramePressure` and `getRendererHealth` were reachable only from
`@vectorvesper/motion`, so a React app importing everything else from `/react`
had to cross to a second entry for those two names alone. Both are on `/react`
now, and the old imports still work.

The `SensorBus` **type** stays on the core entry only. Framer's validator
rejects a module whose declarations forward re-exports at a chunk file, and a
type re-export from a shared core module compiles to exactly that shape in the
`.d.ts`. This is the constraint that made 1.1.1 ship broken. Since 3.0 also
leaves `useSensorBus()` returning the bus, React consumers have no reason to
name the type anyway.

---

## Renames and reshapes

### 1. `getConductor().getStats()` becomes `.state`

```diff
- const stats = getConductor().getStats();
+ const stats = getConductor().state;
```

Five of the six singletons already exposed `.state`. The conductor was the
outlier and the one you reach for most.

### 2. `useSensorBus()` is unchanged, and that is deliberate

**Proposed, then withdrawn during implementation.**

The plan was to have it return `SensorState` directly, matching its three
sibling hooks and removing an apparently pointless `.state` hop. Reading the
implementation killed it.

Those three siblings change rarely: a tier flips, pressure emits at roughly
2Hz, and a re-render on that costs nothing. **Sensor state changes every
frame.** Returning it from a hook means either a snapshot that is stale the
instant you hold it, or a re-render per frame, which is the layout thrashing
the runtime exists to prevent.

The hop is the contract. `useSensorBus()` returns a stable reference and you
read `.state` fresh inside the frame loop. The docblock now says so, so the
next person does not file it as an inconsistency.

### 3. `useVideoScrubber` returns one ref plus values

```diff
- const { trackRef, videoRef, progressRef, scrubberRef } = useVideoScrubber();
+ const { ref,      videoRef, progressRef, scrubberRef } = useVideoScrubber();
```

Only the track ref is renamed. Every other effect hook hands back its primary
element as `ref`, and this was the one shape you could not guess from having
used another.

The original proposal was `{ ref, video, progress, scrubber }`, dropping the
suffixes. Withdrawn while implementing: `progressRef` is a ref deliberately,
carrying the same frame-accurate no-re-render contract as `usePointerIntent`'s
`confidenceRef`. Calling it `progress` would advertise a value that is not
there.

### 4. `offThreadMs` becomes `unattributedMs`

```diff
- pressure.offThreadMs
+ pressure.unattributedMs
```

It is frame time left over after our own work and sampled main-thread work are
subtracted, so it also absorbs compositing, decode, and anything the probe
missed. The old name read as a GPU measurement and needed a disclaimer panel in
the docs. The new name does that work itself.

---

## The three approved design fixes

### 5. `quality` is `null` when nothing is mounted

```diff
- quality: "full" | "reduced"
+ quality: "full" | "reduced" | null
```

```diff
- // 2.x: quality read "reduced" in dormant and warming, because
- // nothing was running. The docs carried a rule: check mounted first.
+ if (scene.quality) { /* genuinely running at this quality */ }
```

I floated a discriminated union on `state` and then rejected it while writing
this. A union cannot survive the destructure that most consumers reach for:

```ts
const { ref, state, quality, mounted } = scene; // narrowing is lost here
```

Union only helps consumers who never destructure a six-field object, which is
not how anyone uses this. `null` keeps destructuring working, says "not
applicable" honestly, and removes the documented rule, which was the point.

### 6. `InteractionScope`'s `active` stops being a tri-state boolean

```diff
- <InteractionScope active={enabled ? undefined : false}>
+ <InteractionScope active={enabled ? "pointer" : false}>
```

```ts
active?: boolean | "pointer"   // default "pointer"
```

In 2.x, `undefined` and `false` meant different things, so opting *in* required
passing `undefined`. We hit this migrating our own scope test and wrote exactly
the line above with `undefined` in it, which is a shape no reader can guess.

I originally proposed splitting this into `activation` plus `active`. Two props
that only make sense in combination is a worse trap than the one being fixed.
One prop with three named values has no hidden state.

- `"pointer"` activates while a pointer is down inside the region. Default.
- `true` holds it active. For a keyboard camera or an open modal.
- `false` never activates.

### 7. `reason` gains a typed companion

```ts
cause: "ok" | "not-near" | "waiting-for-headroom" | "off-screen"
     | "render-bound" | "frame-rate" | "device-floor"
     | "reduced-motion" | "context-lost"
reason: string   // prose, unchanged
```

`reason` is written for a support thread and a devtools row, and the docs told
you not to branch on it. A string you must not use is a trap, so `cause` is the
one you branch on and `reason` is the one you show a human.

### 8. The effect engines are exported

```ts
import { MagneticElement, PointerIntent, VideoScrubber } from "@vectorvesper/motion";
```

New, not breaking.

The README has said the core "works anywhere (vanilla, Vue, Svelte, Framer)"
since 1.0. That was half true. You got the conductor, the sensors, the governors
and the math, and you could not use a single effect, because the classes behind
them were internal while their option types were public. You could name the
options and not construct the thing.

All three already existed and already had tests. Exporting them makes an
existing claim honest.

---

## Order to do it in

1. **Bump and build.** The compiler finds items 1 through 6 for you.
2. **Grep for `.getStats()`, `.state.pointer`, `offThreadMs`, `trackRef`.**
3. **Search for `active={` on `InteractionScope`.** Any `undefined` in that
   expression is item 6.
4. **Search for `.reason` used in a condition.** Those become `.cause`.
5. **Then read the first section again** and spot-check anything that reads
   `tier`, because that is the change with no compile error.

## What did not change

`useTick`, `useSafeToMount`, `useSceneGate`'s options, `damp`, `clamp01`,
`rayRectIntersect`, the conductor's lanes and priorities, `mountDevtools`, and
`useRenderQuality`.
