import { bench, describe } from "vitest";

import { CanvasSceneModel } from "../src/application/canvas/canvasSceneModel";
import { JustifiedFlowModel } from "../src/application/flow/justifiedFlowModel";
import { MasonryFlowModel } from "../src/application/flow/masonryFlowModel";
import { createMediaDataset, streamDataset } from "./mediaFixtures";

const DATASET_10K = createMediaDataset(10_000);
const DATASET_50K = createMediaDataset(50_000);

const preparedMasonry = new MasonryFlowModel({
  viewport: { width: 1440, height: 900 },
  columnCount: 6,
  gap: 10,
});
streamDataset(
  DATASET_50K,
  (items) => preparedMasonry.sync("bench-query", items),
  (items) => preparedMasonry.append("bench-query", items),
);

const preparedCanvas = new CanvasSceneModel({
  atlas: {
    worldWidth: 5000,
    itemHeight: 160,
    gap: 12,
    minItemWidth: 48,
  },
  viewport: {
    cellSize: 512,
    overscanPx: 256,
    thumbnailMinEdgePx: 48,
    detailMinEdgePx: 720,
  },
});
preparedCanvas.setViewport({ width: 1440, height: 900 });
streamDataset(
  DATASET_50K,
  (items) => preparedCanvas.sync("bench-canvas-query", items),
  (items) => preparedCanvas.append("bench-canvas-query", items),
);
const canvasBounds = preparedCanvas.snapshot().bounds;
preparedCanvas.setCenter({
  x: canvasBounds.width / 2,
  y: canvasBounds.height / 2,
});

describe("deterministic 10k incremental layout", () => {
  bench("masonry stream + layout", () => {
    const flow = new MasonryFlowModel({
      viewport: { width: 1440, height: 900 },
      columnCount: 6,
      gap: 10,
    });
    streamDataset(
      DATASET_10K,
      (items) => flow.sync("bench-masonry", items),
      (items) => flow.append("bench-masonry", items),
    );
    if (flow.layoutItemCount !== DATASET_10K.length) {
      throw new Error("masonry benchmark lost media items");
    }
  });

  bench("justified stream + layout", () => {
    const flow = new JustifiedFlowModel({
      viewport: { width: 1440, height: 900 },
      targetRowHeight: 220,
      gap: 10,
    });
    streamDataset(
      DATASET_10K,
      (items) => flow.sync("bench-justified", items),
      (items) => flow.append("bench-justified", items),
    );
    flow.markTerminal();
    if (flow.layoutItemCount !== DATASET_10K.length) {
      throw new Error("justified benchmark lost media items");
    }
  });

  bench("canvas scene stream + index", () => {
    const scene = new CanvasSceneModel({
      atlas: {
        worldWidth: 5000,
        itemHeight: 160,
        gap: 12,
        minItemWidth: 48,
      },
      viewport: {
        cellSize: 512,
        overscanPx: 256,
        thumbnailMinEdgePx: 48,
        detailMinEdgePx: 720,
      },
    });
    scene.setViewport({ width: 1440, height: 900 });
    streamDataset(
      DATASET_10K,
      (items) => scene.sync("bench-canvas", items),
      (items) => scene.append("bench-canvas", items),
    );
    if (scene.itemCount !== DATASET_10K.length) {
      throw new Error("canvas benchmark lost media items");
    }
  });
});

describe("prepared 50k visibility queries", () => {
  bench("masonry middle viewport query", () => {
    const visible = preparedMasonry.queryVisible(
      {
        x: 0,
        y: preparedMasonry.totalHeight / 2,
        width: 1440,
        height: 900,
      },
      { overscan: { top: 900, bottom: 900 } },
    );
    if (visible.length === 0) {
      throw new Error("masonry query returned no visible media");
    }
  });

  bench("canvas spatial query", () => {
    const visible = preparedCanvas.queryVisible(512);
    if (visible.length === 0) {
      throw new Error("canvas query returned no visible media");
    }
  });
});
