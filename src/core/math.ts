/** Shared math for the motion core. */

/**
 * Frame-rate-independent exponential damping — identical feel at 30 and
 * 120fps. `k` is responsiveness per second; higher = tighter tracking.
 */
export function damp(current: number, target: number, k: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-k * dt));
}

export function clamp01(v: number): number {
  // v <= 0 (not < 0) so -0 normalizes to +0.
  return v <= 0 ? 0 : v > 1 ? 1 : v;
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * First time (seconds) at which a point moving at velocity (vx, vy) enters
 * the rect, or null if the ray misses. Slab method; a point already inside
 * returns 0. Zero velocity on an axis requires the point to already be
 * within that axis's span.
 */
export function rayRectIntersect(
  x: number,
  y: number,
  vx: number,
  vy: number,
  rect: RectLike,
): number | null {
  const EPS = 1e-6;
  let tMin = 0;
  let tMax = Infinity;

  if (Math.abs(vx) < EPS) {
    if (x < rect.left || x > rect.right) return null;
  } else {
    const t1 = (rect.left - x) / vx;
    const t2 = (rect.right - x) / vx;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  }

  if (Math.abs(vy) < EPS) {
    if (y < rect.top || y > rect.bottom) return null;
  } else {
    const t1 = (rect.top - y) / vy;
    const t2 = (rect.bottom - y) / vy;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  }

  return tMax >= tMin ? tMin : null;
}
