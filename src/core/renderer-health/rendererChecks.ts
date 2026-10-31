import type { GPUDeviceLike } from "./watchGPUDevice";

/**
 * Two questions both 3D adapters ask of whatever renderer they are handed.
 * Neither adapter may import three, an optional peer, so both read the
 * renderer's shape.
 */

/**
 * The WebGPU device behind a renderer, or null for anything else.
 *
 * `instanceof WebGPURenderer` isn't enough: three's `Renderer.init` catches a
 * WebGPU failure and swaps in a WebGL backend with nothing logged. So this asks
 * the backend what it is and checks the device carries a `lost` promise.
 * Verified against three 0.184.
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
 * A context can die before anything is listening, so asking the context is the
 * only way to find out afterwards. A WebGPU canvas context has no
 * `isContextLost` and reads as alive: its failures arrive through
 * `device.lost`, which a late subscriber still hears.
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
