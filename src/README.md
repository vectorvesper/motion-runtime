# @vectorvesper/motion

The VV motion engine. This folder is the package: `core/` ships as the
zero-dependency entry (`.`), `react/` as the adapter entry (`./react`).
Compiled `dist/` + `.d.ts` only when published — the implementation is the
product, the API is the documentation.

## The three rules

1. **One heartbeat.** Nothing owns a private `requestAnimationFrame`. Every
   per-frame job subscribes to the `FrameConductor`, which runs three lanes
   in fixed order — `input → update → render` — so readers always run before
   writers. The loop only runs while it has subscribers, isolates throwing
   subscribers, and clamps `dt` after tab sleeps.

2. **Fail open.** SSR, missing WebGL2, `prefers-reduced-motion`, lost GL
   contexts, slow devices — every degraded path shows the user their
   content, plainly. Losing an effect must never lose the page.

3. **Per-frame values never enter React state.** Adapters hand back refs
   and callbacks for continuous values; React state is reserved for rare,
   meaningful transitions (a budget tier, an intent boolean).

## Modules

### FrameConductor — `core/conductor`

```ts
const off = getConductor().subscribe("update", (dt, time) => { ... });
```

### SensorBus — `core/sensor-bus`

One set of page-wide input listeners; smoothed derivatives computed once per
frame, before any consumer runs. Read `bus.state.pointer` (position,
velocity px/s, speed, down), `.scroll` (position, velocity), `.viewport`
during frame work. Live objects — read fields, never retain. Ref-counted via
`retain()`; the React adapter (`useSensorBus`) handles that.

### MediaShader — `core/media-shader` · `useMediaShader` · `<ShaderImage>`

GLSL effects on `<img>`/`<video>` via ONE fixed canvas for the whole page
(browsers cap GL contexts). Elements keep layout/semantics at `opacity: 0`;
`destroy()` restores them exactly. Presets are the drop unit: a fragment
shader + defaults against a fixed uniform contract (`u_hover`, `u_pointer`,
`u_cover`, `u_params`, …). Built-ins by string name, custom presets by
object — which is also the premium boundary.

```tsx
<ShaderImage src="/look.jpg" alt="" preset="fluted-glass" />
```

`setMediaShaderResolution(scale)` scales the backing store — the adaptive
quality actuator.

### VideoScrubber — `core/video-scrubber` · `useVideoScrubber`

Scroll / pointer / manual progress mapped onto a video timeline, with the
production knowledge baked in: seek discipline (never seek over an
in-flight seek; `fastSeek` for jumps), iOS buffer priming, attribute
record/restore, offscreen culling. Scroll mappings: `pin` (Apple sticky
pattern), `cross`, `auto`.

### AnimationBudget — `core/animation-budget` · `useAnimationBudget`

Frame-headroom governor. Tiers 0/1/2 with asymmetric hysteresis: degrade in
~a second, recover after ~8 clean ones, panic path for sub-30fps. Decision
logic is `BudgetPolicy` — pure, unit-tested. Consume the tier to shed
expensive layers; pair with `useAdaptiveMediaShaderResolution()` to drive
the canvas scale automatically.

### PointerIntent — `core/pointer-intent` · `usePointerIntent`

Predicts arrival before hover: SensorBus velocity → time-to-impact against
the (inflated) element rect → damped confidence with enter/exit hysteresis.
Pre-warm videos, shaders, magnetic pulls 100–300ms early. Disabled on
coarse pointers.

### useLazyScene — `react/useLazyScene`

Mount heavy scenes only near-viewport + browser-idle (+ optionally budget-
healthy, capped at 3s — content is never hostage to a slow device).

## Testing

`npm test` — vitest over the pure cores: math (damping, ray-rect),
BudgetPolicy state machine, scroll mappings, conductor loop mechanics
(lane order, dt clamp, error isolation, lifecycle).

## Labs

`/lab/media-shader` · `/lab/glass-curtain` · `/lab/video-scrubber` ·
`/lab/perf` · `/lab/pointer-intent`
