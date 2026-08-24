/**
 * The benchmark kit.
 *
 *   npm run bench
 *   npm run bench -- --cpu 1,4        # repeat at CPU throttle rates
 *
 * Two scenarios, each run as an A/B in a real headed Chrome with identical work
 * in both arms. Only the coordination changes.
 *
 * ## What this is for, and what it is not
 *
 * It exists to find out whether the runtime's central claim survives
 * measurement, not to produce a marketing number. If an arm does not win, the
 * table says so and the summary says so. A benchmark you would only publish
 * when it agreed with you is not evidence.
 *
 * The honest limits, stated here because they belong next to the numbers:
 *
 * - **One machine.** Whatever laptop this runs on. Frame budgets, GPU and
 *   thermal behaviour are all machine-specific, and a single row of results is
 *   a data point rather than a benchmark suite.
 * - **Synthetic work.** Sine loops and transforms, not a real product page.
 *   It is representative of "many small animated things", which is the case the
 *   runtime is built for, and not of anything else.
 * - **No thermal component.** A mobile GPU is fine for twenty seconds and then
 *   is not. Nothing here reproduces that.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, launch, until, percentile } from "../lib/cdp.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(DIR, "../..");
const PORT = 9421;
const CDP_PORT = 9422;
const RUN_MS = 5000;
const CALIBRATE_MS = 1600;
/**
 * Per-element work to try while calibrating.
 *
 * Shedding only does anything once a frame is over budget, so a scenario that
 * comfortably holds 60fps measures nothing at all. The first run of this
 * benchmark did exactly that — both arms at 16.7ms, zero subscribers shed —
 * which is a harness reporting no result, not a result.
 *
 * So the load is calibrated per machine before measuring, and the level it
 * settles on is printed. That is the opposite of tuning until the numbers
 * agree: the level is chosen by the *baseline* arm struggling, and then both
 * arms are measured at it.
 */
const LOAD_STEPS = [220, 700, 1800, 4000, 9000, 20000];
/** Calibration target: the baseline arm should be clearly missing frames. */
const TARGET_P95_MS = 26;

const cpuArg = process.argv.find((a) => a.startsWith("--cpu"));
const CPU_RATES = cpuArg
  ? (process.argv[process.argv.indexOf(cpuArg) + 1] ?? "1").split(",").map(Number)
  : [1];

function summarise(result) {
  const iv = result.intervals;
  return {
    frames: iv.length,
    fps: iv.length ? Math.round(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)) : 0,
    p50: percentile(iv, 50),
    p95: percentile(iv, 95),
    worst: iv.length ? Math.max(...iv) : 0,
    workDone: result.workDone,
    lead: result.lead,
    shedTotal: result.shedTotal,
    runTotal: result.runTotal,
  };
}

function row(label, s) {
  const n = (v, d = 1) => v.toFixed(d).padStart(6);
  const leadPart = s.lead
    ? `${String(s.lead.runs).padStart(5)} ${String(s.lead.shed).padStart(5)}`
    : "    —     —";
  return `  ${label.padEnd(14)}${String(s.fps).padStart(4)}  ${n(s.p50)}  ${n(s.p95)}  ${n(s.worst)}  ${leadPart}  ${String(s.workDone).padStart(8)}`;
}

async function main() {
  const server = await serve({
    port: PORT,
    routes: {
      "/": path.join(DIR, "page.html"),
      "/scenarios.mjs": path.join(DIR, "scenarios.mjs"),
    },
    mounts: { "/dist/": path.join(PKG, "dist") },
  });

  const session = await launch({ url: `http://127.0.0.1:${PORT}/`, cdpPort: CDP_PORT });
  const findings = [];

  try {
    await until(session.evaluate, "!!window.__bench");
    await session.front();

    const scenarios = await session.evaluate("window.__bench.scenarios");

    for (const rate of CPU_RATES) {
      await session.cdp.send("Emulation.setCPUThrottlingRate", { rate });
      if (CPU_RATES.length > 1) console.log(`\n### CPU ${rate}x`);

      for (const name of scenarios) {
        const arms = await session.evaluate(
          `window.__bench.arms(${JSON.stringify(name)})`,
        );

        console.log(`\n${name}`);
        console.log("  arm             fps     p50     p95   worst   lead  shed  work done");
        console.log("  " + "─".repeat(70));

        // Calibrate on the BASELINE arm, so the load is chosen by what the
        // uncoordinated case can take rather than by what flatters the other.
        let load = LOAD_STEPS[LOAD_STEPS.length - 1];
        for (const step of LOAD_STEPS) {
          await session.front();
          const probe = await session.evaluate(
            `window.__bench.run(${JSON.stringify(name)}, ${JSON.stringify(arms[0])}, ${CALIBRATE_MS}, ${step})`,
          );
          if (probe.error) throw new Error(probe.error);
          const p95 = percentile(probe.intervals, 95);
          if (p95 >= TARGET_P95_MS) {
            load = step;
            break;
          }
        }
        const count = await session.evaluate(`window.__bench.count(${JSON.stringify(name)})`);
        console.log(`  load: ${count} elements x ${load} iterations`);

        const measured = {};
        for (const arm of arms) {
          await session.front();
          const raw = await session.evaluate(
            `window.__bench.run(${JSON.stringify(name)}, ${JSON.stringify(arm)}, ${RUN_MS}, ${load})`,
          );
          if (raw.error) throw new Error(raw.error);
          measured[arm] = summarise(raw);
          console.log(row(arm, measured[arm]));
        }

        // The comparison, stated as a finding rather than left to the reader.
        const [a, b] = arms;
        const A = measured[a];
        const B = measured[b];
        const p95Delta = A.p95 === 0 ? 0 : ((A.p95 - B.p95) / A.p95) * 100;
        const better = B.p95 < A.p95;
        findings.push({
          scenario: name,
          rate,
          baseline: a,
          candidate: b,
          p95Delta,
          better,
          A,
          B,
        });

        console.log(
          `\n  → ${b} p95 is ${Math.abs(p95Delta).toFixed(1)}% ` +
            `${better ? "lower" : "HIGHER"} than ${a} ` +
            `(${A.p95.toFixed(1)}ms → ${B.p95.toFixed(1)}ms)`,
        );
        if (A.lead && B.lead) {
          console.log(
            `    lead animation ran ${A.lead.runs} → ${B.lead.runs} times`,
          );
        }
        // The trade, stated plainly. A smoother frame reached by doing less is
        // the design working, not a free lunch, and a reader deserves both
        // halves of it.
        const workDelta = A.workDone === 0 ? 0 : ((B.workDone - A.workDone) / A.workDone) * 100;
        console.log(
          `    work completed ${A.workDone} → ${B.workDone} ` +
            `(${workDelta >= 0 ? "+" : ""}${workDelta.toFixed(1)}%)`,
        );
      }
    }

    await session.cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

    console.log("\n" + "═".repeat(74));
    const lost = findings.filter((f) => !f.better);
    if (lost.length === 0) {
      console.log("Every scenario improved on p95 frame time.");
    } else {
      console.log(
        `${lost.length} of ${findings.length} scenario runs did NOT improve:\n` +
          lost
            .map(
              (f) =>
                `  · ${f.scenario} @ ${f.rate}x — ${f.candidate} was ` +
                `${Math.abs(f.p95Delta).toFixed(1)}% worse than ${f.baseline}`,
            )
            .join("\n") +
          "\n\nThat is a result, not a bug in the harness. Read it before" +
          "\nrepeating any claim about coordination.",
      );
    }
    console.log(
      "\nOne machine, synthetic work, no thermal component. A data point," +
        "\nnot a benchmark suite.",
    );
  } finally {
    await session.dispose();
    server.close();
  }
}

main().catch((err) => {
  console.error("✗ benchmark failed:", err.message);
  process.exit(1);
});
