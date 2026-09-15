import { describe, expect, it } from "vitest";

import {
  FLOW_REVEAL_COHORT_MS,
  FLOW_REVEAL_SCAN_STEP_MS,
  selectFlowRevealBatch,
} from "../src/presentation/flowRevealPolicy";

const candidates = [
  { mediaId: "a", y: 0, height: 180 },
  { mediaId: "b", y: 120, height: 260 },
  { mediaId: "c", y: 420, height: 180 },
  { mediaId: "d", y: 760, height: 220 },
];

function pending(...ids: string[]): ReadonlySet<string> {
  return new Set(ids);
}

describe("Flow reveal policy", () => {
  it("reveals every decoded candidate together when stationary", () => {
    expect(
      selectFlowRevealBatch(candidates, pending("a", "b", "c"), 0, 900),
    ).toEqual(["a", "b", "c"]);
  });

  it("advances from top to bottom while scrolling down", () => {
    expect(
      selectFlowRevealBatch(candidates, pending("a", "b", "c", "d"), 1, 900),
    ).toEqual(["a", "b"]);
  });

  it("advances from bottom to top while scrolling up", () => {
    expect(
      selectFlowRevealBatch(candidates, pending("a", "b", "c", "d"), -1, 900),
    ).toEqual(["d", "c"]);
  });

  it("never includes media that has not decoded yet", () => {
    expect(
      selectFlowRevealBatch(candidates, pending("b", "d"), 1, 900),
    ).toEqual(["b"]);
  });

  it("uses short grouping and scan-step delays", () => {
    expect(FLOW_REVEAL_COHORT_MS).toBeGreaterThanOrEqual(20);
    expect(FLOW_REVEAL_COHORT_MS).toBeLessThanOrEqual(60);
    expect(FLOW_REVEAL_SCAN_STEP_MS).toBeGreaterThanOrEqual(8);
    expect(FLOW_REVEAL_SCAN_STEP_MS).toBeLessThanOrEqual(24);
  });
});
