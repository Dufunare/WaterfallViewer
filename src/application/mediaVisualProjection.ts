import type { MediaItem } from "./ports/mediaScan";

export type MediaVisualDeferredReason = "missing-visual" | "invalid-visual";

export type MediaVisualProjection =
  | {
      kind: "visual";
      width: number;
      height: number;
      source: "metadata" | "fallback";
    }
  | {
      kind: "deferred";
      reason: MediaVisualDeferredReason;
    };

/**
 * The legacy Flow experiment intentionally does not read image dimensions while
 * scanning. Views that still need pre-decode geometry therefore receive a
 * conservative fallback until richer metadata is requested elsewhere.
 */
export function projectMediaVisual(item: MediaItem): MediaVisualProjection {
  const visual = item.visual;
  if (
    visual !== null &&
    Number.isFinite(visual.width) &&
    visual.width > 0 &&
    Number.isFinite(visual.height) &&
    visual.height > 0
  ) {
    return {
      kind: "visual",
      width: visual.width,
      height: visual.height,
      source: "metadata",
    };
  }

  if (item.kind === "video") {
    return {
      kind: "visual",
      width: 16,
      height: 9,
      source: "fallback",
    };
  }

  if (
    item.kind === "image" ||
    item.kind === "animated-image" ||
    item.kind === "audio"
  ) {
    return {
      kind: "visual",
      width: 1,
      height: 1,
      source: "fallback",
    };
  }

  return {
    kind: "deferred",
    reason: visual === null ? "missing-visual" : "invalid-visual",
  };
}

export function mediaVisualFingerprint(item: MediaItem): string {
  const projection = projectMediaVisual(item);
  if (projection.kind === "deferred") {
    return `${item.id}:${item.kind}:${projection.reason}`;
  }
  return `${item.id}:${item.kind}:${projection.source}:${projection.width}:${projection.height}`;
}
