import type { GPUDeviceLike } from "./watchGPUDevice";

/**
 * Two questions both 3D adapters ask of whatever renderer they are handed.
 *
 * Neither adapter may import three to answer them. It is an optional peer, and
 * the class a renderer was built from is not a safe answer anyway: a
 * `WebGPURenderer` can be drawing through WebGL without saying so. So both
 * read the renderer's shape.
 */

/**
 * The WebGPU device behind a renderer, or null for anything else.
 *
 * Deliberately not `renderer instanceof WebGPURenderer`. three's `Renderer.init`
 * catches a WebGPU failure and swaps in a WebGL backend, so a `WebGPURenderer`
 * can be drawing through WebGL with nothing logged. Asking the backend what it
 * is, and then checking the device really carries a `lost` promise, is the only
 * reading that survives that fallback. Verified against three 0.184.
 */
export function gpuDeviceOf(renderer: unknown): GPUDeviceLike | null {
  const backend = (renderer as { backend?: { isWebGPUBackend?: boolean; device?: unknown } } | null)
    ?.backend;
  if (!backend?.isWebGPUBackend) return null;
  const device = backend.device as GPUDeviceLike | undefined;
  if (!device || typeof device.lost?.then !== "function") return null;
  return device;
}

/**
 * Whether a renderer's WebGL context is already dead.
 *
 * A context can die before anything is listening for it, and its
 * `webglcontextlost` event has then already fired into nothing. Asking the
 * context is the only way to find out afterwards. A WebGPU canvas context has
 * no `isContextLost` and reads as alive: its failures arrive through
 * `device.lost`, a promise that a late subscriber still hears.
 */
export function isContextLost(renderer: unknown): boolean {
  try {
    const context = (renderer as { getContext?: () => unknown } | null)?.getContext?.() as
      | { isContextLost?: () => boolean }
      | null
      | undefined;
    return context?.isContextLost?.() === true;
  } catch {
    return false;
  }
}
