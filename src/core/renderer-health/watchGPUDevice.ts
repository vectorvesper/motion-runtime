import { getRendererHealth } from "./RendererHealth";

/**
 * The part of `GPUDevice` this needs. Structural, because `@webgpu/types` isn't
 * a dependency: a real `GPUDevice` satisfies this shape, so a project with the
 * types passes its device straight in and a project without them still
 * compiles.
 */
export interface GPUDeviceLike {
  /** Resolves when the device is lost, so a `.catch` here never fires. */
  lost: Promise<{ reason?: string } | undefined>;
}

/** Stop watching. Safe to call more than once. */
export type StopWatchingDevice = () => void;

/**
 * Report a WebGPU device's health to the runtime.
 *
 * WebGPU announces a dead device by resolving `device.lost`, a promise handed
 * to you at creation. As with a lost WebGL context, the canvas stops producing
 * frames, nothing throws, and the console stays clean.
 *
 * ```ts
 * const device = await adapter.requestDevice();
 * const stop = watchGPUDevice(device);
 * // ...later, on teardown
 * stop();
 * ```
 *
 * A loss bumps `generation`, a scene gate hands that to a `key`, and React
 * builds the tree again against a device you request fresh, the same path a
 * WebGL scene uses.
 *
 * A loss with reason `"destroyed"` is ignored: the page called
 * `device.destroy()` itself. Treating a teardown as a loss bumps the generation
 * and remounts everything, which tears down more devices, in a loop.
 *
 * A promise can't be un-awaited, so `stop()` sets a flag the handler checks.
 * Call it in the same cleanup that destroys the device, and a teardown that
 * resolves `lost` afterwards stays quiet.
 */
export function watchGPUDevice(device: GPUDeviceLike): StopWatchingDevice {
  const health = getRendererHealth();
  // Holding a device means a working one. After a loss this is the replacement
  // announcing itself, which is what ends the recovery.
  health.reportHealthy();

  // The generation this device belongs to, so a replacement device lost
  // moments after a rebuild requested it still counts as a new failure.
  const builtAt = health.state.generation;
  let watching = true;

  void device.lost
    .then((info) => {
      if (!watching) return;
      if (info?.reason === "destroyed") return;
      health.reportLost({ builtAt });
    })
    .catch(() => {
      // `lost` should only resolve. A rejection isn't evidence the device died,
      // so nothing is reported.
    });

  return () => {
    watching = false;
  };
}
