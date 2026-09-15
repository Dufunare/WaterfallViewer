import { describe, expect, it } from "vitest";

import {
  FLOW_SCRUB_SETTLE_MS,
  FLOW_WHEEL_ACTIVITY_GRACE_MS,
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

  it("enters scrub mode for non-wheel high-velocity movement even below one screen", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 1400,
        viewportHeight: 900,
        elapsedMs: 50,
      }),
    ).toBe(true);
  });

  it("keeps fast wheel or touchpad browsing out of scrub mode", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 1500,
        viewportHeight: 900,
        elapsedMs: 16,
        recentWheel: true,
      }),
    ).toBe(false);
  });

  it("uses short gesture windows that do not make browsing feel sticky", () => {
    expect(FLOW_SCRUB_SETTLE_MS).toBeGreaterThanOrEqual(50);
    expect(FLOW_SCRUB_SETTLE_MS).toBeLessThanOrEqual(150);
    expect(FLOW_WHEEL_ACTIVITY_GRACE_MS).toBeGreaterThanOrEqual(100);
    expect(FLOW_WHEEL_ACTIVITY_GRACE_MS).toBeLessThanOrEqual(250);
  });
});
