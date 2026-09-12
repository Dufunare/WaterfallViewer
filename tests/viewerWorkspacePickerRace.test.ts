import { describe, expect, it } from "vitest";

import { MediaSessionController } from "../src/application/mediaSession";
import type {
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../src/application/ports/mediaScan";
import type {
  PickedSource,
  SourcePickerPort,
} from "../src/application/ports/sourcePicker";
import { ViewerWorkspaceController } from "../src/application/viewer/viewerWorkspaceController";

class FakeScanPort implements MediaScanPort {
  readonly requests: MediaScanRequest[] = [];

  scan(
    request: MediaScanRequest,
    _onEvent: (event: MediaScanEvent) => void,
  ): Promise<void> {
    this.requests.push(request);
    return new Promise<void>(() => undefined);
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

interface PendingPick {
  resolve: (value: PickedSource | null) => void;
}

class DeferredSourcePicker implements SourcePickerPort {
  readonly pending: PendingPick[] = [];

  pickDirectory(): Promise<PickedSource | null> {
    return new Promise((resolve) => {
      this.pending.push({ resolve });
    });
  }
}

function source(id: string): PickedSource {
  return {
    source: { id, locator: `local-source/${id}` },
    displayName: id,
  };
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

describe("ViewerWorkspaceController picker generations", () => {
  it("ignores an older picker result that arrives after a newer selection", async () => {
    const scanPort = new FakeScanPort();
    const picker = new DeferredSourcePicker();
    const workspace = new ViewerWorkspaceController(
      new MediaSessionController(scanPort, sessionIds("session-1")),
      picker,
    );

    const older = workspace.pickAndOpenSource();
    const newer = workspace.pickAndOpenSource();
    picker.pending[1].resolve(source("newer"));
    await expect(newer).resolves.toBe(true);
    picker.pending[0].resolve(source("older"));
    await expect(older).resolves.toBe(false);

    expect(scanPort.requests).toHaveLength(1);
    expect(scanPort.requests[0].source.id).toBe("newer");
    expect(workspace.sourceDisplayName).toBe("newer");
    workspace.dispose();
  });

  it("does not open a source when the workspace is disposed before the picker resolves", async () => {
    const scanPort = new FakeScanPort();
    const picker = new DeferredSourcePicker();
    const workspace = new ViewerWorkspaceController(
      new MediaSessionController(scanPort, sessionIds("session-1")),
      picker,
    );

    const picking = workspace.pickAndOpenSource();
    workspace.dispose();
    picker.pending[0].resolve(source("late"));

    await expect(picking).resolves.toBe(false);
    expect(scanPort.requests).toEqual([]);
  });
});
