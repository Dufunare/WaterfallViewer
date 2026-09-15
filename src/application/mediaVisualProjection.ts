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
 * Projects media metadata into browseable geometry without starting a decoder.
 *
 * Header metadata is preferred whenever it is available. Missing or malformed
 * geometry must not make an accepted media item disappear from Flow, though:
 * images/animated images fall back to a square tile, video to 16:9 and audio to
 * a square tile. This keeps layoutItemCount/scroll extent aligned with the media
 * index even for formats whose dimensions are not yet covered by the lightweight
 * header reader (for example AVIF/TIFF).
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
    item.kind === "audio" ||
    item.kind === "image" ||
    item.kind === "animated-image"
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
