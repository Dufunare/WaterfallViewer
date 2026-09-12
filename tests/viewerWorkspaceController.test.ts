import { describe, expect, it } from "vitest";

import { MediaSessionController } from "../src/application/mediaSession";
import type {
  MediaItem,
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";
import type {
  PickedSource,
  SourcePickerPort,
} from "../src/application/ports/sourcePicker";
import { ViewerWorkspaceController } from "../src/application/viewer/viewerWorkspaceController";

interface PendingScan {
  request: MediaScanRequest;
  onEvent: (event: MediaScanEvent) => void;
}

class FakeScanPort implements MediaScanPort {
  readonly scans: PendingScan[] = [];
  readonly cancelRequests: string[] = [];

  scan(
    request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    this.scans.push({ request, onEvent });
    return new Promise<void>(() => undefined);
  }

  async cancel(sessionId: string): Promise<boolean> {
    this.cancelRequests.push(sessionId);
    return true;
  }

  emit(scanIndex: number, event: MediaScanEvent): void {
    this.scans[scanIndex].onEvent(event);
  }
}

class QueueSourcePicker implements SourcePickerPort {
  constructor(private readonly queue: Array<PickedSource | null>) {}

  async pickDirectory(): Promise<PickedSource | null> {
    return this.queue.shift() ?? null;
  }
}

function sessionIds(...values: string[]) {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (value === undefined) {
      throw new Error("session id queue exhausted");
    }
    return value;
  };
}

function media(id: string): MediaItem {
  return {
    id,
    sourceId: "source-1",
    name: `${id}.jpg`,
    relativePath: `${id}.jpg`,
    kind: "image",
    fileSize: 100,
    modifiedAtMs: null,
    visual: { width: 100, height: 100 },
    resourceKey: `1/${id.length}`,
  };
}

describe("ViewerWorkspaceController", () => {
  it("owns source selection and opens exactly one shared scan", async () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, sessionIds("session-1"));
    const workspace = new ViewerWorkspaceController(
      sessions,
      new QueueSourcePicker([
        {
          source: { id: "source-1", locator: "local-source/7" },
          displayName: "Photos",
        },
      ]),
      { scanBatchSize: 32 },
    );

    await expect(workspace.pickAndOpenSource()).resolves.toBe(true);

    expect(scanPort.scans).toHaveLength(1);
    expect(scanPort.scans[0].request).toEqual({
      sessionId: "session-1",
      source: { id: "source-1", locator: "local-source/7" },
      batchSize: 32,
    });
    expect(workspace.sourceDisplayName).toBe("Photos");
    expect(workspace.snapshot.sessionId).toBe("session-1");
    workspace.dispose();
  });

  it("publishes shared scan progress and media counts", async () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, sessionIds("session-1"));
    const workspace = new ViewerWorkspaceController(
      sessions,
      new QueueSourcePicker([
        {
          source: { id: "source-1", locator: "local-source/1" },
          displayName: "Gallery",
        },
      ]),
    );
    const snapshots = [] as ReturnType<typeof cloneSnapshot>[];
    const unsubscribe = workspace.subscribe((snapshot) => {
      snapshots.push(cloneSnapshot(snapshot));
    });

    await workspace.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    scanPort.emit(0, {
      event: "batch",
      data: { sessionId: "session-1", items: [media("a"), media("b")] },
    });

    expect(workspace.snapshot.scanState?.status).toBe("scanning");
    expect(workspace.snapshot.itemCount).toBe(2);
    expect(snapshots.some((snapshot) => snapshot.itemCount === 2)).toBe(true);
    expect(snapshots[snapshots.length - 1].sourceDisplayName).toBe("Gallery");

    unsubscribe();
    workspace.dispose();
  });

  it("switches sources through the same workspace and lets the session controller cancel the old scan", async () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(
      scanPort,
      sessionIds("session-1", "session-2"),
    );
    const workspace = new ViewerWorkspaceController(
      sessions,
      new QueueSourcePicker([
        {
          source: { id: "source-1", locator: "local-source/1" },
          displayName: "First",
        },
        {
          source: { id: "source-2", locator: "local-source/2" },
          displayName: "Second",
        },
      ]),
    );

    await workspace.pickAndOpenSource();
    await workspace.pickAndOpenSource();

    expect(scanPort.scans).toHaveLength(2);
    expect(scanPort.cancelRequests).toEqual(["session-1"]);
    expect(workspace.snapshot.sessionId).toBe("session-2");
    expect(workspace.sourceDisplayName).toBe("Second");
    workspace.dispose();
  });

  it("leaves the active workspace unchanged when native picking is cancelled", async () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, sessionIds("session-1"));
    const workspace = new ViewerWorkspaceController(
      sessions,
      new QueueSourcePicker([
        {
          source: { id: "source-1", locator: "local-source/1" },
          displayName: "First",
        },
        null,
      ]),
    );

    await workspace.pickAndOpenSource();
    const before = workspace.snapshot;
    await expect(workspace.pickAndOpenSource()).resolves.toBe(false);

    expect(scanPort.scans).toHaveLength(1);
    expect(workspace.snapshot).toEqual(before);
    workspace.dispose();
  });

  it("delegates cancellation to the shared media session", async () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, sessionIds("session-1"));
    const workspace = new ViewerWorkspaceController(
      sessions,
      new QueueSourcePicker([
        {
          source: { id: "source-1", locator: "local-source/1" },
          displayName: "First",
        },
      ]),
    );

    await workspace.pickAndOpenSource();
    scanPort.emit(0, { event: "started", data: { sessionId: "session-1" } });
    await expect(workspace.cancelScan()).resolves.toBe(true);

    expect(scanPort.cancelRequests).toEqual(["session-1"]);
    expect(workspace.snapshot.scanState?.status).toBe("cancelling");
    workspace.dispose();
  });

  it("validates batch size and stops publishing after disposal", async () => {
    const scanPort = new FakeScanPort();
    const sessions = new MediaSessionController(scanPort, sessionIds("session-1"));
    const picker = new QueueSourcePicker([
      {
        source: { id: "source-1", locator: "local-source/1" },
        displayName: "First",
      },
    ]);

    expect(
      () => new ViewerWorkspaceController(sessions, picker, { scanBatchSize: 0 }),
    ).toThrow(/scanBatchSize/);

    const workspace = new ViewerWorkspaceController(sessions, picker);
    let publications = 0;
    workspace.subscribe(() => {
      publications += 1;
    });
    workspace.dispose();
    const publicationsAtDispose = publications;

    sessions.openSource({ id: "external", locator: "local-source/9" });
    expect(publications).toBe(publicationsAtDispose);
    expect(() => workspace.subscribe(() => undefined)).toThrow(/disposed/);
  });
});

function cloneSnapshot(snapshot: {
  sourceDisplayName: string | null;
  sessionId: string | null;
  scanState: unknown;
  itemCount: number;
}) {
  return {
    ...snapshot,
    scanState:
      snapshot.scanState === null
        ? null
        : JSON.parse(JSON.stringify(snapshot.scanState)) as unknown,
  };
}
