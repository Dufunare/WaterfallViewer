import { describe, expect, it } from "vitest";

import {
  FLOW_SCRUB_SETTLE_MS,
  FLOW_VIEWPORT_SETTLE_SYNC_MS,
  FLOW_VIEWPORT_SYNC_DISTANCE_SCREENS,
  FLOW_WHEEL_ACTIVITY_GRACE_MS,
  shouldEnterFlowScrub,
  shouldSyncFlowViewport,
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

  it("enters scrub mode for a genuinely deep scrollbar jump", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 0,
        scrollTop: 5000,
        viewportHeight: 900,
        elapsedMs: 16,
      }),
    ).toBe(true);
  });

  it("does not classify a moderate scrollbar move as scrub", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 1400,
        viewportHeight: 900,
        elapsedMs: 50,
      }),
    ).toBe(false);
  });

  it("still catches extreme non-wheel velocity", () => {
    expect(
      shouldEnterFlowScrub({
        previousScrollTop: 1000,
        scrollTop: 1700,
        viewportHeight: 900,
        elapsedMs: 40,
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

  it("refreshes the controller only after native scrolling crosses the frontier threshold", () => {
    expect(
      shouldSyncFlowViewport({
        syncedScrollTop: 1000,
        scrollTop: 1300,
        viewportHeight: 900,
      }),
    ).toBe(false);
    expect(
      shouldSyncFlowViewport({
        syncedScrollTop: 1000,
        scrollTop: 1600,
        viewportHeight: 900,
      }),
    ).toBe(true);
  });

  it("uses short settle windows while avoiding per-frame controller churn", () => {
    expect(FLOW_SCRUB_SETTLE_MS).toBeGreaterThanOrEqual(50);
    expect(FLOW_SCRUB_SETTLE_MS).toBeLessThanOrEqual(150);
    expect(FLOW_WHEEL_ACTIVITY_GRACE_MS).toBeGreaterThanOrEqual(100);
    expect(FLOW_WHEEL_ACTIVITY_GRACE_MS).toBeLessThanOrEqual(250);
    expect(FLOW_VIEWPORT_SYNC_DISTANCE_SCREENS).toBeGreaterThanOrEqual(0.4);
    expect(FLOW_VIEWPORT_SYNC_DISTANCE_SCREENS).toBeLessThanOrEqual(0.75);
    expect(FLOW_VIEWPORT_SETTLE_SYNC_MS).toBeGreaterThanOrEqual(40);
    expect(FLOW_VIEWPORT_SETTLE_SYNC_MS).toBeLessThanOrEqual(100);
  });
});
