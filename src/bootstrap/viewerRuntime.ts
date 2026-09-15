import { MediaBrowserController } from "../application/browser/mediaBrowserController";
import { CanvasBrowserController } from "../application/canvas/canvasBrowserController";
import { CanvasSceneModel } from "../application/canvas/canvasSceneModel";
import {
  MediaSessionController,
  type SessionIdFactory,
} from "../application/mediaSession";
import type { MediaDetailPort } from "../application/ports/mediaDetail";
import type { MediaRepresentationPort } from "../application/ports/mediaRepresentation";
import type { MediaResourcePort } from "../application/ports/mediaResource";
import type { MediaScanPort } from "../application/ports/mediaScan";
import type { SourcePickerPort } from "../application/ports/sourcePicker";
import { MediaQueryController } from "../application/query/mediaQueryController";
import { BrowserNativeRepresentationPort } from "../application/resources/browserNativeRepresentation";
import { RepresentationScheduler } from "../application/resources/representationScheduler";
import { MediaSelectionController } from "../application/selection/mediaSelectionController";
import { MediaActivationController } from "../application/viewer/mediaActivationController";
import { PreviewMediaDetailController } from "../application/viewer/previewMediaDetailController";
import { ViewerWorkspaceController } from "../application/viewer/viewerWorkspaceController";

export interface ViewerRuntimePorts {
  scan: MediaScanPort;
  sourcePicker: SourcePickerPort;
  representation: MediaRepresentationPort;
  resource: MediaResourcePort;
  detail: MediaDetailPort;
}

export interface ViewerRuntimeOptions {
  sessionIdFactory?: SessionIdFactory;
  representationMaxConcurrent?: number;
  representationMaxBackgroundConcurrent?: number;
}

export interface ViewerRuntime {
  readonly sessionController: MediaSessionController;
  readonly query: MediaQueryController;
  readonly selection: MediaSelectionController;
  readonly workspace: ViewerWorkspaceController;
  readonly activation: MediaActivationController;
  readonly previewDetails: PreviewMediaDetailController;
  readonly flowBrowser: MediaBrowserController;
  readonly createCanvasBrowser: () => CanvasBrowserController;
  dispose(): void;
}

export function createViewerRuntime(
  ports: ViewerRuntimePorts,
  options: ViewerRuntimeOptions = {},
): ViewerRuntime {
  const sessionController = new MediaSessionController(
    ports.scan,
    options.sessionIdFactory,
  );
  const query = new MediaQueryController(sessionController);
  const selection = new MediaSelectionController(sessionController);

  // Canvas/preview keep the derived-representation pipeline because they need
  // explicit LOD behavior. Flow deliberately uses a separate browser-native
  // adapter: source resource keys are handed straight to the WebView so image
  // decoding, target-size rasterization and decoded-image caching are owned by
  // the browser engine instead of a Rust decode -> resize -> encode round trip.
  const derivedRepresentationScheduler = new RepresentationScheduler(
    ports.representation,
    {
      maxConcurrent: options.representationMaxConcurrent ?? 3,
      maxBackgroundConcurrent:
        options.representationMaxBackgroundConcurrent ?? 1,
    },
  );
  const flowRepresentationScheduler = new RepresentationScheduler(
    new BrowserNativeRepresentationPort(),
    {
      // The adapter itself performs no decode or I/O. A wider handoff window is
      // intentional: it approximates the old frontend's ~25-image batches and
      // lets Chromium/WebView own the real resource/decode scheduling.
      maxConcurrent: 32,
      maxBackgroundConcurrent: 32,
    },
  );

  const workspace = new ViewerWorkspaceController(
    sessionController,
    ports.sourcePicker,
  );
  const activation = new MediaActivationController(
    sessionController,
    ports.resource,
  );
  const previewDetails = new PreviewMediaDetailController(
    activation,
    ports.detail,
  );
  const flowBrowser = new MediaBrowserController(
    {
      sessionController,
      sourcePicker: ports.sourcePicker,
      representationScheduler: flowRepresentationScheduler,
      resourcePort: ports.resource,
    },
    {
      // In browser-native mode maxThumbnailEdge is only a scheduling/cache key;
      // the source file itself is delivered unchanged to the WebView.
      maxThumbnailEdge: 768,
      // The old frontend retained loaded image wrappers aggressively. Keeping a
      // larger URI-state window is a cheap approximation while DOM rendering
      // remains virtualized for now.
      warmThumbnailCount: 512,
    },
  );
  const canvasScene = new CanvasSceneModel({
    atlas: {
      worldWidth: 4096,
      itemHeight: 260,
      gap: 18,
      minItemWidth: 72,
    },
    viewport: {
      cellSize: 512,
      overscanPx: 0,
      thumbnailMinEdgePx: 48,
      detailMinEdgePx: 960,
      camera: {
        minZoom: 0.05,
        maxZoom: 24,
      },
    },
  });

  const createCanvasBrowser = () =>
    new CanvasBrowserController(
      {
        sessionController,
        sourcePicker: ports.sourcePicker,
        representationScheduler: derivedRepresentationScheduler,
        resourcePort: ports.resource,
        scene: canvasScene,
      },
      {
        renderOverscanPx: 320,
        maxThumbnailEdge: 2048,
        maxDetailEdge: 4096,
      },
    );

  let disposed = false;
  return {
    sessionController,
    query,
    selection,
    workspace,
    activation,
    previewDetails,
    flowBrowser,
    createCanvasBrowser,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      previewDetails.dispose();
      activation.dispose();
      flowBrowser.dispose();
      workspace.dispose();
      selection.dispose();
      query.dispose();
    },
  };
}
