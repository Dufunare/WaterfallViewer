export interface ThumbnailRequest {
  resourceKey: string;
  maxEdge: number;
}

export interface ThumbnailRepresentation {
  resourceKey: string;
  width: number;
  height: number;
}

export interface MediaRepresentationPort {
  requestThumbnail(request: ThumbnailRequest): Promise<ThumbnailRepresentation>;
}
