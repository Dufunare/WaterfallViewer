import type { InjectionKey } from "vue";

import type { MediaSelectionController } from "../application/selection/mediaSelectionController";

export const mediaSelectionKey: InjectionKey<MediaSelectionController> = Symbol(
  "waterfallviewer-media-selection",
);
