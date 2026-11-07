import { Channel, invoke } from "@tauri-apps/api/core";

import type {
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../../application/ports/mediaScan";

interface TauriStartScanRequest {
  sessionId: string;
  sourceId: string;
  sourceLocator: string;
  batchSize: number;
}

export async function scanMedia(
  request: MediaScanRequest,
  onEvent: (event: MediaScanEvent) => void,
): Promise<void> {
  const channel = new Channel<MediaScanEvent>();
  let resolveTerminal: (() => void) | null = null;
  const terminalEvent = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });

  channel.onmessage = (event) => {
    onEvent(event);
    if (event.event === "finished" || event.event === "cancelled") {
      resolveTerminal?.();
      resolveTerminal = null;
    }
  };

  const ipcRequest: TauriStartScanRequest = {
    sessionId: request.sessionId,
    sourceId: request.source.id,
    sourceLocator: request.source.locator,
    batchSize: request.batchSize,
  };

  await Promise.all([
    invoke("start_scan", { request: ipcRequest, onEvent: channel }),
    terminalEvent,
  ]);
}

export async function cancelScan(sessionId: string): Promise<boolean> {
  return invoke<boolean>("cancel_scan", { sessionId });
}

export const tauriMediaScanPort: MediaScanPort = {
  scan: scanMedia,
  cancel: cancelScan,
};
