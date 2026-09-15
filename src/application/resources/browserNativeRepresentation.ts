import type {
  MediaRepresentationPort,
  ThumbnailRepresentation,
  ThumbnailRequest,
} from "../ports/mediaRepresentation";

/**
 * Experimental Flow representation adapter that deliberately does not create a
 * derived thumbnail. The source resource key already identifies an opaque,
 * session-scoped local media resource, so returning it lets the WebView own the
 * decode/raster/cache path just like a browser-native Blob URL would.
 *
 * This adapter is intentionally tiny: it exists so Flow can A/B the old
 * thumbnail pipeline against a browser-native source pipeline without leaking
 * filesystem paths into the frontend or changing Canvas/preview LOD behavior.
 */
export class BrowserNativeRepresentationPort implements MediaRepresentationPort {
  async requestThumbnail(
    request: ThumbnailRequest,
    signal?: AbortSignal,
  ): Promise<ThumbnailRepresentation> {
    if (signal?.aborted) {
      const error = new Error("browser-native representation request aborted");
      error.name = "AbortError";
      throw error;
    }

    return {
      resourceKey: request.resourceKey,
      // Flow already lays tiles out from scan metadata. These values satisfy the
      // representation contract only; no resize has actually happened here.
      width: request.maxEdge,
      height: request.maxEdge,
    };
  }
}
