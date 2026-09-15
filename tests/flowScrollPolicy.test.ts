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

  it("keeps a moderate scrollbar move inside the retained warm canvas", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 2100,
        viewportHeight: 900,
        elapsedMs: 120,
      }),
    ).toBe(false);
  });

  it("enters scrub mode for a deep scrollbar jump", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 0,
        scrollTop: 5000,
        viewportHeight: 900,
        elapsedMs: 50,
      }),
    ).toBe(true);
  });

  it("enters scrub mode for extreme non-wheel velocity", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 1600,
        viewportHeight: 900,
        elapsedMs: 30,
      }),
    ).toBe(true);
  });

  it("keeps fast wheel or touchpad browsing out of scrub mode", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 2500,
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
