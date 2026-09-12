import { describe, expect, it } from "vitest";

import { MasonryFlowModel } from "../src/application/flow/masonryFlowModel";
import { MediaIndex } from "../src/application/mediaSession";
import type { MediaItem } from "../src/application/ports/mediaScan";

function media(id: string, height = 100): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: `${id}.jpg`,
    relativePath: `${id}.jpg`,
    kind: "image",
    fileSize: 100,
    modifiedAtMs: null,
    visual: { width: 100, height },
    resourceKey: `1/${id}`,
  };
}

const config = {
  viewport: { width: 220, height: 160 },
  columnCount: 2,
  gap: 20,
};

describe("incremental media flow", () => {
  it("exposes only the appended MediaIndex tail and tracks replacements separately", () => {
    const index = new MediaIndex();
    index.upsertMany([media("a"), media("b")]);

    expect(index.valuesFrom(1).map((item) => item.id)).toEqual(["b"]);
    expect(index.replacementRevision).toBe(0);

    index.upsertMany([media("c")]);
    expect(index.valuesFrom(2).map((item) => item.id)).toEqual(["c"]);
    expect(index.replacementRevision).toBe(0);

    index.upsertMany([media("a", 200)]);
    expect(index.replacementRevision).toBe(1);
    expect(index.ids()).toEqual(["a", "b", "c"]);
  });

  it("keeps direct O(batch) append geometry equivalent to one-shot layout", () => {
    const items = [media("a"), media("b", 200), media("c"), media("d", 150)];

    const incremental = new MasonryFlowModel(config);
    incremental.sync("session-1", items.slice(0, 2));
    incremental.append("session-1", items.slice(2));

    const oneShot = new MasonryFlowModel(config);
    oneShot.sync("session-1", items);

    expect(incremental.snapshot()).toEqual(oneShot.snapshot());
  });

  it("rejects duplicate append batches atomically", () => {
    const model = new MasonryFlowModel(config);
    model.sync("session-1", [media("a")]);
    const before = model.snapshot();

    expect(() => model.append("session-1", [media("b"), media("a")])).toThrow(
      /duplicate media id/,
    );
    expect(model.snapshot()).toEqual(before);
  });
});
