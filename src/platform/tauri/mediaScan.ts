import { Channel, invoke } from "@tauri-apps/api/core";

export type MediaKind = "image" | "animated-image" | "video" | "audio";

export interface VisualMetadata {
  width: number;
  height: number;
}

export interface MediaItem {
  id: string;
  sourceId: string;
  name: string;
  relativePath: string;
  kind: MediaKind;
  fileSize: number;
  modifiedAtMs?: number;
  visual?: VisualMetadata;
}

export interface ScanSummary {
  discoveredFiles: number;
  acceptedMedia: number;
  emittedBatches: number;
}

export interface ScanWarning {
  path?: string;
  message: string;
}

export type ScanEvent =
  | { event: "started"; data: { sessionId: string } }
  | { event: "batch"; data: { sessionId: string; items: MediaItem[] } }
  | { event: "warning"; data: { sessionId: string; warning: ScanWarning } }
  | { event: "finished"; data: { sessionId: string; summary: ScanSummary } }
  | { event: "cancelled"; data: { sessionId: string; summary: ScanSummary } };

export interface StartScanRequest {
  sessionId: string;
  sourceId: string;
  rootPath: string;
  batchSize: number;
}

export async function scanMedia(
  request: StartScanRequest,
  onEvent: (event: ScanEvent) => void,
): Promise<void> {
  const channel = new Channel<ScanEvent>();
  channel.onmessage = onEvent;
  await invoke("start_scan", { request, onEvent: channel });
}

export async function cancelScan(sessionId: string): Promise<boolean> {
  return invoke<boolean>("cancel_scan", { sessionId });
}
