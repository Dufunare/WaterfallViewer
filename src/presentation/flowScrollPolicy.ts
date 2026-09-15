export interface FlowScrollSample {
  previousScrollTop: number;
  scrollTop: number;
  viewportHeight: number;
  elapsedMs: number;
}

/**
 * A scrollbar-thumb drag can traverse many cold viewports in only a few frames.
 * Loading media for every transient viewport wastes disk I/O, custom-protocol
 * responses and Chromium decode work. Flow treats those movements as scrubbing:
 * geometry keeps following the scrollbar, while image DOM is gated until the
 * viewport settles.
 */
export const FLOW_SCRUB_SETTLE_MS = 90;

const SCRUB_JUMP_SCREENS = 0.9;
const SCRUB_VELOCITY_PX_PER_MS = 6;

export function shouldEnterFlowScrub(sample: FlowScrollSample): boolean {
  requireFiniteNonNegative(sample.previousScrollTop, "previousScrollTop");
  requireFiniteNonNegative(sample.scrollTop, "scrollTop");
  requireFinitePositive(sample.viewportHeight, "viewportHeight");
  requireFinitePositive(sample.elapsedMs, "elapsedMs");

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
