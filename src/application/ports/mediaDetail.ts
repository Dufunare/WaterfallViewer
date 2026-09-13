import type { MediaKind } from "./mediaScan";

export interface VideoDetail {
  kind: "video";
  durationMs: number | null;
  codec: string | null;
}

export interface AudioDetail {
  kind: "audio";
  durationMs: number | null;
  title: string | null;
  artist: string | null;
  codec: string | null;
}

export type MediaDetail = VideoDetail | AudioDetail;

export interface MediaDetailRequest {
  resourceKey: string;
  kind: MediaKind;
}

export interface MediaDetailPort {
  getDetail(request: MediaDetailRequest): Promise<MediaDetail | null>;
}
