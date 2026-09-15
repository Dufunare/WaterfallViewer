import { describe, expect, it } from "vitest";

import {
  FLOW_SCRUB_SETTLE_MS,
  shouldEnterFlowScrub,
} from "../src/presentation/flowScrollPolicy";

describe("Flow scroll scrub policy", () => {
  it("keeps ordinary small-step scrolling in normal loading mode", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 1080,
        viewportHeight: 900,
        elapsedMs: 16,
      }),
    ).toBe(false);
  });

  it("enters scrub mode for a large scrollbar jump", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 0,
        scrollTop: 5000,
        viewportHeight: 900,
        elapsedMs: 16,
      }),
    ).toBe(true);
  });

  it("enters scrub mode for sustained high-velocity movement even below one screen", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 1400,
        viewportHeight: 900,
        elapsedMs: 50,
      }),
    ).toBe(true);
  });

  it("uses a short settle delay so the final viewport wins without feeling sticky", () => {
    expect(FLOW_SCRUB_SETTLE_MS).toBeGreaterThanOrEqual(50);
    expect(FLOW_SCRUB_SETTLE_MS).toBeLessThanOrEqual(150);
  });
});
