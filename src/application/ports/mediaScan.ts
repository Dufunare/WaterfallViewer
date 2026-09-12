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
  modifiedAtMs: number | null;
  visual: VisualMetadata | null;
  /** Platform-issued opaque handle. It is not a filesystem path or URL. */
  resourceKey: string;
}

export interface SourceDescriptor {
  id: string;
  /** Adapter-specific locator. Application code treats this as opaque data. */
  locator: string;
}

export interface ScanSummary {
  discoveredFiles: number;
  acceptedMedia: number;
  emittedBatches: number;
}

export interface ScanWarning {
  path: string | null;
  message: string;
}

export type MediaScanEvent =
  | { event: "started"; data: { sessionId: string } }
  | { event: "batch"; data: { sessionId: string; items: MediaItem[] } }
  | { event: "warning"; data: { sessionId: string; warning: ScanWarning } }
  | { event: "finished"; data: { sessionId: string; summary: ScanSummary } }
  | { event: "cancelled"; data: { sessionId: string; summary: ScanSummary } };

export interface MediaScanRequest {
  sessionId: string;
  source: SourceDescriptor;
  batchSize: number;
}

export interface MediaScanPort {
  scan(
    request: MediaScanRequest,
    onEvent: (event: MediaScanEvent) => void,
  ): Promise<void>;

  cancel(sessionId: string): Promise<boolean>;
}
