# Changelog

## 4.3.0

### The licence is now Apache 2.0

No code changed. The runtime is byte-identical to 4.2.0.

**Nothing is taken away.** Every version up to and including 4.2.0 was released
under MIT, and that grant is irrevocable. If you hold one of those versions, or
install one, your rights under MIT are exactly what they were. Apache 2.0
applies from this release onward.

**What Apache 2.0 adds**, all of it in your favour as a user of the runtime:

- **An express patent grant.** MIT only implies one, and no court has settled
  what that implication covers. Legal teams reviewing a dependency ask for this.
- **Patent retaliation.** Sue anyone over patents in this software and your own
  licence to it ends.
- **An explicit trademark carve-out.** Using the code grants no right to the
  Vector Vesper name. MIT is silent on the question.
- **A clearer attribution trail.** A fork has to say which files it changed and
  keep the `NOTICE` file, which now ships in the tarball.

It stays OSI-approved open source, and it stays permissive: you can still use
the runtime in closed commercial work, with no obligation to publish anything.
The one practical loss is that Apache 2.0 cannot be combined with GPLv2 code,
where MIT could. GPLv3 is fine.

## 4.2.0

### Closing one R3F canvas no longer rebuilds every other scene

`useRenderQuality` reported a context loss that React Three Fiber causes on
purpose. R3F calls `forceContextLoss()` on every `<Canvas>` it unmounts, 500ms
after React has removed it, and that fires `webglcontextlost` exactly like a
real failure. The adapter's listener was never removed, so the loss was
reported, the page's `generation` moved, and every gated scene on the page
rebuilt. Tabs, modals, a configurator that closes, any conditional canvas:
each close rebuilt the rest.

Measured in the vv-lab test app: six tab switches under a managed R3F hero
rebuilt it four times on Chrome, where the same page without the runtime
rebuilt it zero times. On WebKit the rebuilds came fast enough that R3F wired
its pointer events to a container that was already gone
(`TypeError: null is not an object`), and the hero stayed dead.

The listener now ignores a loss on a canvas that has left the document, and is
removed when its owner unmounts or a rebuilt canvas replaces it. A loss on a
canvas still on the page is reported exactly as before.

### The scene gate no longer goes back to full quality under the worst load

`useSceneGate` reduced quality at tier 1 and ran at full quality at tier 2.
`decide()` tested `tier === 1`, so the worst tier, sustained drops below
~30fps, fell through to `active`: the harder the page struggled, the more the
gate asked of it. Measured in vv-lab on a managed R3F hero at a 3x pixel
ratio: AdaptiveQuality read tier 2 from the first second, and the gate stayed
reduced only for the dwell left over from an earlier tier-1 verdict, then went
to full quality at 10–12fps for the rest of the run.

Tier 2 now reduces quality like tier 1. The fused tier only reaches 2 when
reducing would help or cannot be ruled out, so a main thread blocked by
someone else is still never answered by degrading: that case arrives as
`held`, at the device's own tier.

No test covered it. Every tier-2 case also set `deviceTier: 2`, which shows the
poster before the tier is read.

### Number tickers stop once they land, and start when their element arrives

`useNumberTicker` kept its conductor subscription after the number reached its
target, and every frame for the life of the page assigned the same text again.
Measured in vv-lab: 105 to 180 text writes a second on a page of three
counters with nothing moving. It now unsubscribes on landing. A new value
starts a fresh approach from wherever the number is, and a write is skipped
when the text would not change.

It also never started when its element arrived on a later commit, behind a
hydration guard, a loading branch or `next/dynamic`. The effect read
`ref.current` once, found nothing and waited for a new `value`, so the counter
stayed blank. It now uses the same hybrid ref as `useSceneGate` and
`usePointerIntent`, so the element arriving is what starts it.

### The magnet, the image trail and the video scrubber start when their element arrives

`useMagneticIntent`, `useImageTrail` and `useVideoScrubber` read their element
once, in an effect keyed on mount-time options. An element behind a hydration
guard, a loading branch or `next/dynamic` never got a magnet, a trail or a
scrubber: the same defect as the ticker above. All three use the hybrid ref
now. The scrubber keys on its track as well, so a track that arrives after the
video is still picked up. `effects.test.tsx` checks each hook with its element
on the first commit and on a later one.

### A Mac on Safari is no longer rated a phone

`deviceTierFromSignals` treated the renderer string "Apple GPU" as a
mobile-class GPU. Safari reports that string on every Apple device, an M3 Max
included, so every Mac on Safari started at tier 1 and the reduced profile
before a single frame was measured. `DeviceSignals` gains an optional `touch`:
touch points (`navigator.maxTouchPoints`) or touch events, either one. "Apple
GPU" counts as mobile-class only with touch, which no Mac has and an iPad asking
for the desktop site still reports. With touch unknown, the old cautious
reading stands.

### A forgotten `reportHealthy()` no longer kills a scene

`RendererHealth.reportLost()` returned early while `lost` was set. Code that
never called `reportHealthy()` therefore survived exactly one loss: the next was
swallowed and the canvas stayed black. vv-site's own landing demo died that way
on its second "Drop Context".

A later loss now always counts, and the coalescing window alone keeps one reset
to one rebuild. If nothing reports healthy within 5 seconds, the runtime
assumes the rebuild worked, clears `lost` so that gates leave `recovering`, and
warns once, naming the call to add. `useRenderQuality` still reports healthy
for you.

### A scene lost again moments after its rebuild now rebuilds again

`RendererHealth` folds every loss within 250ms of the last one into the same
rebuild, because one driver reset reaches every canvas on the page. A
replacement that rebuild had just built, lost inside the same quarter second,
was folded in too. It did not exist when the reset happened, so it was a new
failure, and it stayed black with nothing left to rebuild it. Two quick clicks
on vv-site's "Drop Context" did it.

`reportLost()` takes an optional `{ builtAt }`: the generation that was current
when the lost canvas's renderer was created. A loss from a canvas built under
the current generation always counts. An older canvas's loss inside the window
is still folded in, and a report without `builtAt` is judged by the window
alone, as before. `useRenderQuality` and `watchGPUDevice` pass it for you. A
hand-built renderer can read `getRendererHealth().state.generation` when it is
created.

So that a page with more canvases than the browser keeps contexts for cannot
rebuild forever, fresh canvases can trigger at most three rebuilds in a row
this way. After that the runtime warns once and waits for the next separate
loss.

### A context lost while R3F is still building the scene is no longer missed

React Three Fiber creates the WebGL context, builds the scene, and only then
calls `onCreated`, which is where `useRenderQuality` starts listening. A loss
in between fired with nothing listening: three.js logged "Context Lost", the
runtime never heard, and the scene stayed black for good. On Safari's engine
that gap is long enough for a second reset to land in it, and vv-lab
reproduced it on the first round. `onCreated` now asks the context whether it
is already dead, and reports the loss instead of announcing a healthy canvas.

### New: `@vectorvesper/motion/three`, a plain three.js scene in one call

`useThreeScene` does for a hand-written three.js scene what `useSceneGate` and
`useRenderQuality` do for R3F, in one hook. You make the renderer and build
the scene; it does the rest:

- builds nothing until the scene is near the viewport and the page can afford
  it, and never mid-scroll
- draws on the shared frame loop, and not at all while the scene is off screen
- keeps the pixel ratio at or below the screen's own, and lowers it on the live
  renderer when the frame rate cannot hold, without a rebuild
- follows the element's size, and a `PerspectiveCamera`'s aspect with it
- listens for a lost context from the moment the renderer exists, then builds a
  new renderer and scene and reports when the new one has drawn
- frees every geometry, material and texture in the scene, the renderer and the
  context itself when the scene goes
- never builds under reduced motion or on a device below the floor, so a still
  image can show instead

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
```

The entry imports nothing from three. The renderer's shape is all it reads,
so a `WebGPURenderer` works the same way. In vv-lab, the plain three.js hero
rewritten with it passed every probe the hand-wired reference passes, on
Chrome and Safari's engine, on desktop and mobile. It also passed both new
double-reset probes, one of which the hand-wired version fails until it passes
`builtAt`. The hand-wired version takes two files and about ten separate
steps.

### A profile's `dpr` is now a ceiling

`useRenderQuality` applied `dpr` exactly as written, and every example writes
`full: { dpr: 2 }`. On a 1x monitor that drew four times the pixels the screen
can show, so the managed scene came out heavier than the unmanaged one it
replaced, whose R3F default resolves to 1 there. Measured in vv-lab: an
AI-written hero that copied `dpr: 2` from our own pattern ran at 8–12fps, where
the same page with the ratio capped ran at about 20. `dpr` is now the most the
canvas draws at, and never more than the screen's own ratio. A 3x phone still
gets 2.

### `useSceneGate({ content: true })`, for sections a reader came for

The gate sends a scene to its poster under reduced motion and on a device below
the floor, and `mounted` never turns true. That is right for decoration and
wrong for a chart. vv-lab's own heavy-chart reference used the gate for its
wait on the scroll and on frame headroom, and a visitor who asked for less
motion would never have seen the chart. With `content: true` the section still
waits to be near, for the scroll to settle and for frame headroom, then mounts,
in the constrained state, whatever the motion preference or the device.

## 4.1.0

WebGPU device loss.

### What this adds

`watchGPUDevice(device)` reports a WebGPU device's health to the runtime, the
way the R3F adapter's `onCreated` already does for a WebGL context.

```ts
const device = await adapter.requestDevice();
const stop = watchGPUDevice(device);
// on teardown
stop();
```

WebGL announces a dead context with a `webglcontextlost` event. WebGPU
announces a dead device by resolving `device.lost`, a promise handed to you at
creation. Different shape, same failure: the canvas stops producing frames,
nothing throws, and the console stays clean.

Everything downstream is unchanged. A loss bumps `generation`, a scene gate
hands that to a `key`, and React rebuilds against a device you request fresh.
The counter never cared which API died, so `useSceneGate` works over WebGPU
today with no changes.

### A device you destroyed is not a device that failed

`GPUDeviceLostInfo.reason` is `"destroyed"` when the page called
`device.destroy()` itself. That case is ignored.

This is the WebGL lesson carried across rather than relearned. Dropping a
context on unmount used to report a loss after its replacement had already
reported healthy, which bumped the generation, which remounted everything,
which unmounted more contexts. One page reached generation 18 inside a second
with nobody touching it.

### `useRenderQuality` wires it for you

The R3F adapter now watches the device as well as listening for
`webglcontextlost`, so a WebGPU scene mounted through `useSceneGate` recovers
with no extra code. Everything else it does already worked over WebGPU: R3F
applies `dpr` through `setPixelRatio` and shadows through `shadowMap.enabled`
without checking the renderer's type, and three's `WebGPURenderer` carries
both. The dead context listener was the only gap.

It attaches both paths rather than choosing between them. `Renderer.init`
catches a WebGPU failure and quietly swaps in a WebGL backend, so a
`WebGPURenderer` can be drawing through WebGL with nothing logged. Wiring both
means recovery does not depend on classifying the renderer correctly.

Verified in Chrome against a real `WebGPURenderer`: the device exists by the
time `onCreated` fires, `dpr` reaches the renderer, the loop still stops when
the scene goes idle, a real `device.destroy()` resolves with reason
`"destroyed"` and is ignored, and a loss rebuilds a scene that draws again.

### Also

`DeviceSignals` gains `webgpu`, true when `navigator.gpu` exists. It says the
API is available and nothing more: adapter limits need `requestAdapter()`,
which is async and cannot inform a synchronous probe. The flag does not move
the device tier.

`@webgpu/types` is not a dependency and will not become one. `GPUDeviceLike`
is a structural type covering the one field this reads, so a real `GPUDevice`
satisfies it whether or not your project has the types installed.

## 4.0.3

One driver reset rebuilt every scene on the page sixteen times.

### The bug

`reportLost()` has always guarded against a reset being counted once per
canvas. That guard only holds while `lost` is true, and `reportHealthy()`
clears it the moment the first replacement mounts.

`webglcontextlost` is async and the remount it triggers is synchronous, so on
a page with several canvases the two interleave:

```
lost    gen 1     canvas 1's event
healthy gen 1     canvas 1's replacement is up
lost    gen 2     canvas 2's event, still from the same reset
healthy gen 2
lost    gen 3
...
```

Every bump changes the `<Canvas key>` for every scene on the page, so one
reset on sixteen canvases produced **generation 16**: sixteen full rebuilds and
up to 256 context creations against a browser that keeps about sixteen. Scenes
lost that race and stayed black, which is the exact failure this is here to
prevent.

Reproduced: sixteen `reportLost()`/`reportHealthy()` pairs took the generation
to 16. It is now 1.

### The fix

A loss arriving within 250ms of the previous one is treated as the same reset
reaching another canvas, not as a new failure. The canvas reporting it has
already been replaced by the rebuild the first report triggered, so the event
describes an element no longer in the document.

Nothing to change in your code. A genuinely separate failure a second later
still counts, and single-canvas pages are unaffected.

## 4.0.2

An off-screen scene went black instead of holding its last frame.

### The bug

`useRenderQuality` treated every state that was not `"active"` as `reduced`,
`"idle"` included. So scrolling a scene off screen lowered its pixel ratio at
the same moment it stopped the render loop.

Changing `dpr` resizes the canvas drawing buffer, and **resizing a WebGL
drawing buffer clears it**. With the loop stopped, nothing redrew. The scene
did not freeze on its last frame the way the docs promise — it was erased and
left blank until it came back into view.

This hits any consumer whose `full` and `reduced` profiles use different `dpr`
values, which is the documented usage.

Measured on a page of sixteen gated scenes: active canvases at 660×494, idle
canvases at 330×247 and empty.

It also bought nothing. A scene that is not drawing costs no frame time at any
resolution, and the memory is already allocated. The `dpr` axis belongs to
`"constrained"`, where the scene is still drawing and should draw cheaper.

### The fix

No API change, nothing to update. The pixel ratio now stops moving when drawing
stops, and resumes from whatever state the scene comes back into.

- `active` → `idle` keeps the full ratio, so the last frame survives.
- `constrained` → `idle` keeps the reduced one, for the same reason.
- Coming back to any drawing state applies that state's profile immediately;
  a resize is wanted there, because the next frame repaints it.
- A scene that *mounts* already idle still starts at `reduced`. There is no
  frame to preserve yet.

## 4.0.1

Quality tiers inverted on high-refresh displays.

`AnimationBudget` scored frame times against a fixed 16.7ms target, so on a
240Hz panel a page running at a comfortable 100fps was measured against a 4.2ms
budget and reported the worst tier. Excellent performance read as failure, and
the scenes that trusted it degraded themselves for no reason.

Thresholds are now derived from the display's own refresh rate, with a quality
floor so a very fast panel cannot demand more than the eye can use.

## 4.0.0

`useRenderQuality` did not work. This fixes it, and the fix changes how it is
called.

### The bug

Since it shipped, the R3F adapter set the pixel ratio, the frame loop and the
shadow map imperatively from inside `<Canvas>`, through `setDpr`,
`setFrameloop` and `gl.shadowMap.enabled`. React Three Fiber re-runs its
configure pass on **every `<Canvas>` render** and resets all three from the
props:

```js
if (dpr && state.viewport.dpr !== calculateDpr(dpr)) state.setDpr(dpr);
if (state.frameloop !== frameloop) state.setFrameloop(frameloop);
gl.shadowMap.enabled = !!shadows;
```

R3F 9 defaults `dpr` to `[1, 2]` and `frameloop` to `"always"`, so every call
the adapter made was undone on the next render. Measured in a real browser
against 3.0.1: an idle scene kept rendering, 167 further frames over three
seconds, and a renderer asked for `dpr: 1` sat at 1.25.

In other words, the two things the adapter exists for, capping the pixel ratio
and stopping the loop off screen, were not happening for anyone.

### The fix, and what you have to change

`useRenderQuality` now returns props to spread onto `<Canvas>`, and moves
outside it. R3F owns these settings, so the only way to hold them is to be what
R3F reconciles against.

```diff
- function Rig({ state }: { state: SceneState }) {
-   useRenderQuality(state, PROFILES);
-   return null;
- }
-
- <Canvas key={scene.generation}>
-   <Rig state={scene.state} />
-   <Hero detail={scene.quality} />
- </Canvas>

+ const canvas = useRenderQuality(scene.state, PROFILES);
+
+ <Canvas key={scene.generation} {...canvas}>
+   <Hero detail={scene.quality} />
+ </Canvas>
```

Remove any `dpr`, `frameloop` or `shadows` prop you were passing to `<Canvas>`
yourself. Two owners of one setting is the whole problem, and yours will win.

**This does not produce a compile error.** The old call still type-checks,
because ignoring a return value is legal, and it still renders. It quietly does
nothing, and you also lose the context-loss recovery that did work before. That
silence is why this is a major bump rather than a patch: there is no way for
the compiler to tell you.

- The module no longer imports any React Three Fiber value, only React. The
  peers stay declared because the props it returns are only meaningful to an
  R3F canvas.
- New exported type `RenderQualityProps`.
### Three SSR crashes in the core entry

Found by calling the public surface in Node with no DOM, which nothing had ever
done. All three threw on a server:

```
getAdaptiveQuality().state        window is not defined
getAdaptiveQuality().subscribe()  requestAnimationFrame is not defined
getSensorBus().retain()           window is not defined
```

None of them ever surfaced in React, because every React hook touches the
runtime from an effect and effects do not run on the server. But the core entry
ships without a `"use client"` directive specifically so Nuxt, SvelteKit and
Astro can import it, and any of those reading a governor or holding the bus
during SSR crashed the render.

The device probe now short-circuits when there is no browser, the conductor does
not try to start a loop without `requestAnimationFrame`, and the sensor bus does
not try to attach listeners to a window that is not there. Subscribing and
retaining both still succeed and still return working releases; they simply have
no frames to deliver until the client hydrates.

**The server reports quality tier 0, deliberately.** The signals classifier maps
"no WebGL2" to tier 2, the poster tier, so the naive default would render the
static fallback and then flash to a full scene the moment a capable device
hydrated. Tier 0 is what `useAdaptiveQuality`'s INITIAL already renders, so both
entries produce the same server markup.

New `src/ssr.test.ts` walks the whole public surface in a node environment, so a
future export that touches a browser global at call time fails there.

### Also

- **`fuse` and `QualityCause` are exported** from the core entry. `fuse` is the
  pure function behind `AdaptiveQuality`, taking a device tier, a budget tier, a
  motion preference and a pressure reading, and returning the effective tier
  plus the reason for it. Exported for the same stated reason as
  `SAFE_TO_MOUNT_COST` and `POINTER_INTENT_SENSITIVITY`: a devtools panel or a
  documentation page explaining a verdict needs the real rule, and the
  alternative is every such surface keeping a copy that drifts. That drift had
  already happened. The adaptive-quality docs page was still computing
  `max(deviceTier, budgetTier)`, which stopped being the rule in 3.0.
- New `npm run test:vanilla`: a plain HTML page with no React, no bundler and
  no framework, importing the built ESM core and constructing `PointerIntent`,
  `MagneticElement` and `VideoScrubber` by hand. The package has advertised
  vanilla / Vue / Svelte support since 1.0 and nothing had ever exercised it;
  every existing test was a node unit test, a jsdom React test, or a browser
  check that went through the React docs site. It passes, including `destroy()`
  releasing the shared loop back to zero subscribers. Not wired into
  `prepublishOnly`, because it needs a real Chrome.
- The r3f tests were green throughout the entire period the adapter was broken.
  They mocked `useThree` and asserted that the imperative calls happened, which
  was true, while never checking that the renderer ended up in the requested
  state. They now assert the returned props, and the end-to-end claim is
  checked against a real renderer in a real browser instead.

## 3.0.1

Packaging only. The runtime code is byte-identical to 3.0.0.

Two files were wrong in the 3.0.0 tarball:

- **`LICENSE.fsl-draft.md` was published by accident.** npm always includes
  anything matching `LICENSE.*`, regardless of the `files` array, so a
  source-available licence draft that has not been decided on shipped inside a
  package that declares MIT. The authoritative signals were both correct, the
  `license` field and the `LICENSE` file, so nothing was mislicensed, but two
  licence files in one tarball is not something to leave standing. Renamed so
  npm stops treating it as one.

- **`MIGRATION-3.0.md` was missing.** 3.0 is a breaking release and the guide
  was in the repo rather than the package, which is no use to anyone consuming
  it from npm. Added to `files`.

If you already installed 3.0.0, upgrading is optional: the code is the same.
Take 3.0.1 if you want the migration guide alongside it.

## 3.0.0

Quality decisions now know **why** the frame is slow.

Full migration guide: `MIGRATION-3.0.md`, shipped in this package.

### The one change with no compile error

Up to 2.x, `AdaptiveQuality` was `max(deviceTier, budgetTier)` and never looked
at what was actually costing the frame. The rule this runtime is built around,
that reducing quality only helps when *rendering* is the bottleneck, lived
inside `useSceneGate` and nowhere else.

So every component reading `useAdaptiveQuality()` directly degraded on frame
rate alone, which means it degraded while a third-party script blocked the main
thread. A smaller scene does nothing for that. It makes the page uglier and
exactly as slow. Twenty-one of our own thirty components were on that path.

3.0 folds the pressure classifier into the governor:

```
2.x   tier = max(deviceTier, budgetTier)
3.0   tier = max(deviceTier, budgetTier), except the budget half is ignored
            when the classifier can prove the frame is blocked by something
            a smaller scene cannot fix
```

The device floor stays absolute. When the classifier has no verdict, which is
any frame under 25% over budget, the budget tier is trusted exactly as before.

**What you will notice:** components stop dipping to low quality while a heavy
third-party script runs. **What to check:** anything expecting `tier` to track
frame rate one for one. It tracks *actionable* slowness now. For raw frame rate,
`useAnimationBudget().tier` is unchanged.

`AdaptiveState` gains `cause`, so the reason is readable rather than inferred:
`"ok" | "device" | "reduced-motion" | "render" | "frame-rate" | "held"`.
`"held"` is the new one: the budget wanted to degrade and was overruled.

### Breaking

- **`/effects` merged into `/react`.** `usePointerIntent`, `useMagneticIntent`,
  `useImageTrail`, `useNumberTicker`, `useVideoScrubber` and
  `POINTER_INTENT_SENSITIVITY` all move. Their option types stay on the core
  entry. The 2.0 split was argued as "the entries match the layers", but
  `sideEffects: false` already tree-shakes an unused hook, so it bought zero
  bytes and both of our own apps immediately wrote a shim collapsing it back.

  An entry point now has to pass one test: does it protect you from a
  dependency you do not have? `.` protects from React, `/r3f` from three,
  `/devtools` from overlay weight. `/effects` protected from nothing.

- **`getConductor().getStats()` is now `.state`.** Five of the six singletons
  already exposed `.state`. The conductor was the outlier and the one you reach
  for most.

- **`PressureState.offThreadMs` is now `unattributedMs`.** It is the frame time
  left after our own work and sampled main-thread work are subtracted, so it
  also absorbs compositing, decode, and anything the probe missed. The old name
  read as a GPU measurement and needed a disclaimer in the docs.

- **`useVideoScrubber().trackRef` is now `.ref`.** Every other effect hook hands
  its primary element back as `ref`. The other three keep their `Ref` suffix
  because they genuinely are refs.

- **`SceneGate.quality` is `"full" | "reduced" | null`.** It used to read
  `"reduced"` in `dormant` and `warming`, not because quality was reduced but
  because nothing was running, and the docs carried a rule telling you to check
  `mounted` first. A value needing a rule to read correctly is a defect.

- **`InteractionScope`'s `active` is `boolean | "pointer"`,** default
  `"pointer"`. It used to be `boolean | undefined` where `undefined` and
  `false` meant different things, so opting back into pointer activation meant
  passing `undefined` and an A/B toggle came out as
  `active={on ? undefined : false}`.

### Added

- **`SceneGate.cause`**, a typed counterpart to `reason`:
  `"ok" | "not-near" | "waiting-for-headroom" | "off-screen" | "render-bound" |
  "frame-rate" | "device-floor" | "reduced-motion" | "context-lost"`. `reason`
  stays prose for a support thread. Branch on `cause`.

- **The three effect engines are exported**: `PointerIntent`,
  `MagneticElement`, `VideoScrubber`, with `VIDEO_SCRUBBER_DEFAULTS` and
  `scrollProgress`. This README has claimed vanilla, Vue and Svelte support
  since 1.0, and until now a non-React consumer got the conductor, the sensors,
  the governors and the maths, and could not use a single effect, because these
  classes were internal while their option types were public. You could name
  the options and not construct the thing.

- **`getFramePressure` and `getRendererHealth` on `/react`.** They were
  reachable only from the core entry, so a React app crossed to a second entry
  for those two names alone.

- **`fuse()` exported from the adaptive-quality module** so the rule above is
  testable on its own. Ten tests cover it.

### Fixed

- **`useSceneGate` never started when its ref target was absent on the first
  commit.** The observer effect read `ref.current` once, keyed on `[preload]`,
  so any component rendering a spinner, a Suspense fallback or a
  `next/dynamic` placeholder before its real tree attached no
  `IntersectionObserver` at all, and nothing re-ran the effect when the element
  arrived. The scene stayed `dormant` permanently with no error. Shipped in
  2.0.0, fixed in 2.0.1, repeated here because it is the defect most likely to
  have bitten you.

- **The pressure probe's render scenario had stopped being a load.** It drove a
  fixed 420 shader iterations, chosen when that produced 30-40ms frames. Faster
  hardware turned the same load into 17-19ms, under the classifier's
  attribution line, so it correctly answered `"none"` and the test failed for
  being right. The scenario now steers itself into 2x to 3.2x the measured
  frame budget.

### Documented

`SLOW_FACTOR` now explains why it sits at 1.25, roughly 48fps, against
`AnimationBudget`'s 1.11, roughly 54fps. The gap is deliberate: the budget
answers "is the page struggling", pressure answers "which subsystem is to blame
once it clearly is". Stated plainly, and worth repeating here: **this is not a
general render-pressure detector.** A page dropping to 55fps on the GPU reads
`"none"`, and the budget tier is what covers that band.

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
