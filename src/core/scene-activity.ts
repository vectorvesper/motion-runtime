/**
 * How many of the runtime's own scenes are drawing right now.
 *
 * Internal, and deliberately tiny. presentation-cap.ts needs one fact before it
 * believes the browser is capping the page: that the slow, steady cadence is
 * not coming from our own scenes. A gate that is drawing counts itself in here
 * and out again when it stops.
 *
 * Counts gates, not canvases. A hand-built loop with no gate is invisible to
 * it, which is the conservative direction: an unseen scene can only make the
 * cap harder to believe, never easier.
 */

let drawing = 0;

/**
 * Count one scene as drawing. Returns the release, which is safe to call more
 * than once so a React effect cleanup can never drive the count negative.
 */
export function markSceneDrawing(): () => void {
  drawing++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    drawing--;
  };
}

/** Scenes currently drawing. */
export function scenesDrawing(): number {
  return drawing;
}
