import { getRendererHealth } from "./RendererHealth";

/**
 * The part of `GPUDevice` this needs.
 *
 * Structural on purpose. `@webgpu/types` is not a dependency here and will not
 * become one: a real `GPUDevice` satisfies this shape, so a project that has
 * the types passes its device straight in, and a project that does not still
 * compiles. Same reasoning as the `CreatedState` shape in the R3F adapter.
 */
export interface GPUDeviceLike {
  /**
   * Resolves when the device is lost. It resolves rather than rejects, which
   * is the detail most code gets wrong: a `.catch` here never fires.
   */
  lost: Promise<{ reason?: string } | undefined>;
}

/** Stop watching. Safe to call more than once. */
export type StopWatchingDevice = () => void;

/**
 * Report a WebGPU device's health to the runtime.
 *
 * WebGL announces a dead context with a `webglcontextlost` event. WebGPU
 * announces a dead device by resolving `device.lost`, a promise handed to you
 * at creation. Different shape, same failure: the canvas stops producing
 * frames, nothing throws, and the console stays clean.
 *
 * ```ts
 * const device = await adapter.requestDevice();
 * const stop = watchGPUDevice(device);
 * // ...later, on teardown
 * stop();
 * ```
 *
 * What the runtime does with it is unchanged. A loss bumps `generation`, a
 * scene gate hands that to a `key`, and React builds the tree again against a
 * device you request fresh. The recovery path a WebGL scene already uses works
 * here without modification, because the counter never cared which API died.
 *
 * ## Why `destroyed` is ignored
 *
 * `GPUDeviceLostInfo.reason` is `"destroyed"` when the page called
 * `device.destroy()` itself, and unknown when the device actually failed. Only
 * the second is a failure worth rebuilding for.
 *
 * Treating a deliberate teardown as a loss is not hypothetical. The WebGL side
 * shipped exactly that bug: dropping a context on unmount reported a loss
 * *after* its replacement had already reported healthy, which bumped the
 * generation again and remounted everything, which unmounted more contexts.
 * One page reached generation 18 in a second with nobody touching it. A device
 * you destroyed on purpose is not a device that needs replacing.
 *
 * ## Cancellation
 *
 * A promise cannot be un-awaited, so `stop()` sets a flag the handler checks
 * rather than detaching anything. Call it in the same cleanup that destroys the
 * device, and a teardown ordering that resolves `lost` afterwards stays quiet.
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
      // `lost` resolves rather than rejects. If an implementation rejects it
      // anyway, that is not evidence the device died, so nothing is reported.
    });

  return () => {
    watching = false;
  };
}
