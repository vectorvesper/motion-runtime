/**
 * The benchmark kit.
 *
 *   npm run bench
 *   npm run bench -- --cpu 1,4        # repeat at CPU throttle rates
 *
 * Two scenarios, each run as an A/B in a real headed Chrome with identical work
 * in both arms. Only the coordination changes. If an arm doesn't win, the table
 * and summary say so.
 *
 * Limits:
 *
 * - One machine. Frame budgets, GPU and thermal behaviour are machine-specific.
 * - Synthetic work. Sine loops and transforms stand for many small animated
 *   things, and for nothing else.
 * - No thermal component. A mobile GPU is fine for twenty seconds and then
 *   isn't.
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
 * holds 60fps measures nothing. So the load is calibrated per machine before
 * measuring and the level is printed. The level is chosen by the baseline arm
 * struggling, and both arms are measured at it.
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
    gaps: result.gaps ?? [],
    lead: result.lead,
    shedTotal: result.shedTotal,
    runTotal: result.runTotal,
  };
}

/**
 * How uneven one decorative element's cadence was.
 *
 * `worstGap` is the longest stall in frames; `jitter` is the share of gaps that
 * differ from the typical one. A steady 1-in-3 has jitter near zero and looks
 * smooth. The same amount of work delivered irregularly has high jitter and is
 * what a viewer calls glitchy.
 */
function cadence(gaps) {
  if (gaps.length < 4) return { worstGap: 0, jitter: 0 };
  const typical = percentile(gaps, 50);
  const off = gaps.filter((g) => g !== typical).length;
  return { worstGap: Math.max(...gaps), jitter: off / gaps.length };
}

function row(label, s) {
  const n = (v, d = 1) => v.toFixed(d).padStart(6);
  const leadPart = s.lead
    ? `${String(s.lead.runs).padStart(5)} ${String(s.lead.shed).padStart(5)}`
    : "    —     —";
  const c = cadence(s.gaps);
  return `  ${label.padEnd(14)}${String(s.fps).padStart(4)}  ${n(s.p50)}  ${n(s.p95)}  ${leadPart}  ${String(s.workDone).padStart(7)}  ${String(c.worstGap).padStart(4)}  ${(c.jitter * 100).toFixed(0).padStart(5)}%`;
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
        console.log("  arm             fps     p50     p95   lead  shed  work do  stall  jitter");
        console.log("  " + "─".repeat(70));

        // Calibrate on the baseline arm, so the load is chosen by what the
        // uncoordinated case can take.
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
        const a = arms[0];
        const b = arms[1];
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
        // Print the distribution, because a summary statistic can disagree with
        // what someone watched.
        for (const arm of arms) {
          const g = measured[arm].gaps;
          if (!g.length) continue;
          const hist = {};
          for (const v of g) hist[v] = (hist[v] ?? 0) + 1;
          const top = Object.entries(hist)
            .sort((x, y) => y[1] - x[1])
            .slice(0, 5)
            .map(([gap, n]) => `${gap}f x${n}`)
            .join("  ");
          console.log(`    ${arm.padEnd(14)} tracked element gaps: ${top}`);
        }

        if (A.lead && B.lead) {
          console.log(
            `    lead animation ran ${A.lead.runs} → ${B.lead.runs} times`,
          );
        }
        // Show the trade: a smoother frame reached by doing less work.
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
