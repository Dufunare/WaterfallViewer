export interface FlowRevealCandidate {
  mediaId: string;
  y: number;
  height: number;
}

export type FlowRevealDirection = -1 | 0 | 1;

/**
 * Decoded images are held very briefly so several resources that finish close
 * together can become visible on the same paint instead of popping in one by
 * one across the viewport.
 */
export const FLOW_REVEAL_COHORT_MS = 36;

/** Subsequent directional bands advance roughly one frame apart. */
export const FLOW_REVEAL_SCAN_STEP_MS = 16;

const FLOW_REVEAL_BAND_SCREENS = 0.45;
const FLOW_REVEAL_MIN_BAND_PX = 180;

/**
 * Pick the next decoded cohort to reveal.
 *
 * When the user is stationary we reveal every decoded candidate together. When
 * scrolling, only the leading vertical band is revealed. Repeating this once
 * per frame creates a directional scan-front while keeping a single unusually
 * slow image from blocking the rest of the viewport.
 */
export function selectFlowRevealBatch(
  candidates: readonly FlowRevealCandidate[],
  pendingMediaIds: ReadonlySet<string>,
  direction: FlowRevealDirection,
  viewportHeight: number,
): string[] {
  requireFinitePositive(viewportHeight, "viewportHeight");

  const pending = candidates
    .filter((candidate) => pendingMediaIds.has(candidate.mediaId))
    .map((candidate, sequence) => {
      requireFinite(candidate.y, `y for ${candidate.mediaId}`);
      requireFinitePositive(candidate.height, `height for ${candidate.mediaId}`);
      return { ...candidate, sequence };
    });

  if (pending.length === 0) {
    return [];
  }

  if (direction === 0) {
    return pending.map((candidate) => candidate.mediaId);
  }

  const bandHeight = Math.max(
    FLOW_REVEAL_MIN_BAND_PX,
    viewportHeight * FLOW_REVEAL_BAND_SCREENS,
  );

  if (direction > 0) {
    pending.sort((left, right) => left.y - right.y || left.sequence - right.sequence);
    const leadingY = pending[0].y;
    return pending
      .filter((candidate) => candidate.y <= leadingY + bandHeight)
      .map((candidate) => candidate.mediaId);
  }

  pending.sort((left, right) => {
    const leftBottom = left.y + left.height;
    const rightBottom = right.y + right.height;
    return rightBottom - leftBottom || left.sequence - right.sequence;
  });
  const leadingBottom = pending[0].y + pending[0].height;
  return pending
    .filter(
      (candidate) =>
        candidate.y + candidate.height >= leadingBottom - bandHeight,
    )
    .map((candidate) => candidate.mediaId);
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

function requireFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
}
