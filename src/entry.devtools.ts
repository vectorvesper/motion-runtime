/**
 * @vectorvesper/motion/devtools — the live runtime inspector ("./devtools")
 *
 * Zero runtime dependencies, no framework. A separate entry point so it only
 * reaches bundles that ask for it — guard the call with your own dev check if
 * you want it stripped from production.
 */

export {
  mountDevtools,
  type DevtoolsOptions,
  type DevtoolsCorner,
} from "./devtools/overlay";

// Re-exported so a HUD of your own can be built on the same numbers the
// overlay uses, without importing the whole core surface.
export {
  getConductor,
  type ConductorStats,
  type SubscriberStat,
  type SubscriberPriority,
} from "./core/conductor";
