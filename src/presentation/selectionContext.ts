import { inject, type InjectionKey } from "vue";

import type { MediaSelectionController } from "../application/selection/mediaSelectionController";

export const mediaSelectionKey: InjectionKey<MediaSelectionController> = Symbol(
  "waterfallviewer-media-selection",
);

export function useMediaSelection(): MediaSelectionController {
  const selection = inject(mediaSelectionKey);
  if (selection === undefined) {
    throw new Error("viewer media selection context is required");
  }
  return selection;
}
