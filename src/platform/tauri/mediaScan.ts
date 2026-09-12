import { Channel, invoke } from "@tauri-apps/api/core";

import type {
  MediaScanEvent,
  MediaScanPort,
  MediaScanRequest,
} from "../../application/ports/mediaScan";

interface TauriStartScanRequest {
  sessionId: string;
  sourceId: string;
  rootPath: string;
  batchSize: number;
}

export async function scanMedia(
  request: MediaScanRequest,
  onEvent: (event: MediaScanEvent) => void,
): Promise<void> {
  const channel = new Channel<MediaScanEvent>();
  channel.onmessage = onEvent;

  const ipcRequest: TauriStartScanRequest = {
    sessionId: request.sessionId,
    sourceId: request.source.id,
    rootPath: request.source.locator,
    batchSize: request.batchSize,
  };

  await invoke("start_scan", { request: ipcRequest, onEvent: channel });
}

export async function cancelScan(sessionId: string): Promise<boolean> {
  return invoke<boolean>("cancel_scan", { sessionId });
}

export const tauriMediaScanPort: MediaScanPort = {
  scan: scanMedia,
  cancel: cancelScan,
};
