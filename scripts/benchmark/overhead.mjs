/**
 * Scheduler overhead and allocation, measured rather than asserted.
 *
 * The claim this package makes is that one shared loop is cheaper than N
 * private ones. That is only worth saying if the shared loop's own bookkeeping
 * is negligible, and "negligible" has to be a number someone else can
 * reproduce. Run: `npm run bench:overhead`.
 *
 * Node, not a browser: this measures the scheduler, not rendering. rAF is
 * driven by hand through a single reusable slot so the harness itself
 * allocates nothing and cannot be mistaken for the thing being measured.
 */
let pending = null;
globalThis.requestAnimationFrame = (cb) => { pending = cb; return 1; };
globalThis.cancelAnimationFrame = () => { pending = null; };

const { getConductor, damp } = await import("../../dist/index.js");

const SUBS = Number(process.env.SUBS ?? 40);
const FRAMES = Number(process.env.FRAMES ?? 50_000);

const conductor = getConductor();
let ticks = 0;
for (let i = 0; i < SUBS; i++) {
  conductor.subscribe("update", () => { ticks++; }, { priority: "essential", label: `overhead-${i}` });
}

const frame = (t) => { const cb = pending; pending = null; if (cb) cb(t); };

for (let i = 0; i < 5_000; i++) frame(i * 16.67);        // JIT warm-up
if (globalThis.gc) { globalThis.gc(); globalThis.gc(); }

const heapBefore = process.memoryUsage().heapUsed;
const start = process.hrtime.bigint();
for (let i = 0; i < FRAMES; i++) frame((5_000 + i) * 16.67);
const end = process.hrtime.bigint();
const heapAfter = process.memoryUsage().heapUsed;

const usPerFrame = Number(end - start) / FRAMES / 1_000;
const budget60 = 1_000_000 / 60;

console.log(`conductor — ${SUBS} subscribers over ${FRAMES} frames (${ticks} callbacks)`);
console.log(`  overhead        ${usPerFrame.toFixed(2)} µs/frame  (${((usPerFrame / budget60) * 100).toFixed(3)}% of a 60fps budget)`);
console.log(`  per subscriber  ${((usPerFrame * 1000) / SUBS).toFixed(1)} ns`);
if (globalThis.gc) {
  console.log(`  allocation      ${((heapAfter - heapBefore) / FRAMES).toFixed(2)} B/frame  (run with --expose-gc for this to mean anything)`);
} else {
  console.log(`  allocation      not measured — re-run with --expose-gc`);
}

// damp(), on its own: the arithmetic every effect leans on.
let v = 0;
for (let i = 0; i < 1_000_000; i++) v = damp(v, 1, 8, 0.016);
const dStart = process.hrtime.bigint();
const N = 20_000_000;
for (let i = 0; i < N; i++) v = damp(v, 1, 8, 0.016);
const dEnd = process.hrtime.bigint();
console.log(`damp()            ${(Number(dEnd - dStart) / N).toFixed(2)} ns/call`);
