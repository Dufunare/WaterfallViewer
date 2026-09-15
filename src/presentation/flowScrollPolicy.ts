export interface FlowScrollSample {
  previousScrollTop: number;
  scrollTop: number;
  viewportHeight: number;
  elapsedMs: number;
  /**
   * Wheel/trackpad scrolling is continuous browsing, not random-access
   * scrubbing. Even fast wheels can exceed the velocity threshold for a frame,
   * so callers explicitly protect recent wheel-driven motion from scrub mode.
   */
  recentWheel?: boolean;
}

export interface FlowViewportSyncSample {
  syncedScrollTop: number;
  scrollTop: number;
  viewportHeight: number;
}

/**
 * A scrollbar-thumb drag can traverse many cold viewports in only a few frames.
 * Loading media for every transient viewport wastes disk I/O, custom-protocol
 * responses and Chromium decode work. Flow treats only genuinely deep/fast
 * movements as scrubbing. Moderate drags stay in continuous-canvas mode and are
 * served from already materialized tiles.
 */
export const FLOW_SCRUB_SETTLE_MS = 90;

/**
 * Scroll events may trail the wheel event that caused them slightly (especially
 * with high-resolution touchpads / smooth scrolling). Keep the interaction in
 * continuous-browse mode for this short grace window.
 */
export const FLOW_WHEEL_ACTIVITY_GRACE_MS = 180;

/**
 * Native scrolling should move already-mounted content without forcing the
 * controller/Vue tree to rebuild every frame. Refresh the viewport only after
 * the user has crossed a substantial fraction of one screen, then do one final
 * settled refresh for small residual movement.
 */
export const FLOW_VIEWPORT_SYNC_DISTANCE_SCREENS = 0.55;
export const FLOW_VIEWPORT_SETTLE_SYNC_MS = 64;

const SCRUB_JUMP_SCREENS = 2;
const SCRUB_VELOCITY_PX_PER_MS = 12;

export function shouldEnterFlowScrub(sample: FlowScrollSample): boolean {
  requireFiniteNonNegative(sample.previousScrollTop, "previousScrollTop");
  requireFiniteNonNegative(sample.scrollTop, "scrollTop");
  requireFinitePositive(sample.viewportHeight, "viewportHeight");
  requireFinitePositive(sample.elapsedMs, "elapsedMs");

  if (sample.recentWheel === true) {
    return false;
  }

  const distance = Math.abs(sample.scrollTop - sample.previousScrollTop);
  const jumpThreshold = sample.viewportHeight * SCRUB_JUMP_SCREENS;
  const velocity = distance / sample.elapsedMs;

  return distance >= jumpThreshold || velocity >= SCRUB_VELOCITY_PX_PER_MS;
}

export function shouldSyncFlowViewport(sample: FlowViewportSyncSample): boolean {
  requireFiniteNonNegative(sample.syncedScrollTop, "syncedScrollTop");
  requireFiniteNonNegative(sample.scrollTop, "scrollTop");
  requireFinitePositive(sample.viewportHeight, "viewportHeight");

  return (
    Math.abs(sample.scrollTop - sample.syncedScrollTop) >=
    sample.viewportHeight * FLOW_VIEWPORT_SYNC_DISTANCE_SCREENS
  );
}

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}
