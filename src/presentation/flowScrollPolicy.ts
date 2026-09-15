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

/**
 * A scrollbar-thumb drag can traverse many cold viewports in only a few frames.
 * Loading media for every transient viewport wastes disk I/O, custom-protocol
 * responses and Chromium decode work. Flow treats those movements as scrubbing:
 * geometry keeps following the scrollbar, while image DOM is gated until the
 * viewport settles.
 */
export const FLOW_SCRUB_SETTLE_MS = 90;

/**
 * Scroll events may trail the wheel event that caused them slightly (especially
 * with high-resolution touchpads / smooth scrolling). Keep the interaction in
 * continuous-browse mode for this short grace window.
 */
export const FLOW_WHEEL_ACTIVITY_GRACE_MS = 180;

const SCRUB_JUMP_SCREENS = 0.9;
const SCRUB_VELOCITY_PX_PER_MS = 6;

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
