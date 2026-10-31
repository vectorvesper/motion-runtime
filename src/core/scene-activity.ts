/**
 * How many of the runtime's own scenes are drawing right now.
 *
 * Internal. presentation-cap.ts needs one fact before it believes the browser
 * is capping the page: that the slow, steady cadence isn't coming from our own
 * scenes. A gate counts itself in while it draws.
 *
 * Counts gates, so a hand-built loop with no gate is invisible. That is the
 * safe direction: an unseen scene can only make the cap harder to believe.
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
