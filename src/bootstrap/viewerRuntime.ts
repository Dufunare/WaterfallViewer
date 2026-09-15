import { LegacyFlowBrowserController } from "../application/browser/legacyFlowBrowserController";
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
}

export interface ViewerRuntime {
  readonly sessionController: MediaSessionController;
  readonly query: MediaQueryController;
  readonly selection: MediaSelectionController;
  readonly workspace: ViewerWorkspaceController;
  readonly activation: MediaActivationController;
  readonly previewDetails: PreviewMediaDetailController;
  readonly flowBrowser: LegacyFlowBrowserController;
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
  const representationScheduler = new RepresentationScheduler(
    ports.representation,
    { maxConcurrent: options.representationMaxConcurrent ?? 6 },
  );
  const workspace = new ViewerWorkspaceController(
    sessionController,
    ports.sourcePicker,
    {
      // The legacy browser started consuming files almost as soon as traversal
      // discovered them. Keep native IPC amortized, but make first discovery
      // substantially earlier than the production 64-item batch.
      scanBatchSize: 16,
    },
  );
  const activation = new MediaActivationController(
    sessionController,
    ports.resource,
  );
  const previewDetails = new PreviewMediaDetailController(
    activation,
    ports.detail,
  );

  // Experimental Flow path. It deliberately bypasses MediaBrowserController
  // and the derived-thumbnail scheduler: the presentation receives opaque
  // source URIs and reproduces the original frontend's append-only `Image`
  // lifecycle and batch gate. Canvas remains on the production architecture so
  // the experiment isolates only Flow behavior.
  const flowBrowser = new LegacyFlowBrowserController(
    sessionController,
    ports.resource,
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
        representationScheduler,
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
