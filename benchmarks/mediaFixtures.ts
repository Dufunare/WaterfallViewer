import type { MediaItem } from "../src/application/ports/mediaScan";

export const BENCH_BATCH_SIZE = 64;

export function createMediaItem(index: number): MediaItem {
  const kind = mediaKindFor(index);
  const width = 240 + ((index * 97) % 1760);
  const height = 180 + ((index * 53) % 1020);
  return {
    id: `bench-media-${index}`,
    sourceId: "bench-source",
    name: `media-${index}.${extensionFor(kind)}`,
    relativePath: `nested/${Math.floor(index / 1000)}/media-${index}.${extensionFor(kind)}`,
    kind,
    fileSize: 1024 + index * 17,
    modifiedAtMs: index * 1000,
    visual:
      kind === "audio"
        ? null
        : {
            width,
            height,
          },
    resourceKey: `bench/${index + 1}`,
  };
}

export function createMediaDataset(count: number): MediaItem[] {
  return Array.from({ length: count }, (_, index) => createMediaItem(index));
}

export function streamDataset(
  items: readonly MediaItem[],
  syncFirst: (items: readonly MediaItem[]) => void,
  append: (items: readonly MediaItem[]) => void,
  batchSize = BENCH_BATCH_SIZE,
): void {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive integer");
  }
  if (items.length === 0) {
    syncFirst([]);
    return;
  }

  const firstEnd = Math.min(batchSize, items.length);
  syncFirst(items.slice(0, firstEnd));
  for (let start = firstEnd; start < items.length; start += batchSize) {
    append(items.slice(start, Math.min(items.length, start + batchSize)));
  }
}

function mediaKindFor(index: number): MediaItem["kind"] {
  const bucket = index % 20;
  if (bucket === 0) {
    return "video";
  }
  if (bucket === 1) {
    return "audio";
  }
  if (bucket === 2) {
    return "animated-image";
  }
  return "image";
}

function extensionFor(kind: MediaItem["kind"]): string {
  switch (kind) {
    case "image":
      return "jpg";
    case "animated-image":
      return "gif";
    case "video":
      return "mp4";
    case "audio":
      return "mp3";
  }
}
