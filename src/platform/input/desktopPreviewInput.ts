import type { ViewerInputAction } from "./actions";

export interface PreviewKeyboardInput {
  key: string;
  defaultPrevented: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  keepsNativeArrowBehavior: boolean;
}

export interface PreviewNavigationState {
  hasPrevious: boolean;
  hasNext: boolean;
}

export function mapDesktopPreviewKey(
  input: PreviewKeyboardInput,
  navigation: PreviewNavigationState,
): ViewerInputAction | null {
  if (input.key === "Escape") {
    return { type: "back" };
  }

  if (
    input.defaultPrevented ||
    input.altKey ||
    input.ctrlKey ||
    input.metaKey ||
    input.shiftKey ||
    input.keepsNativeArrowBehavior
  ) {
    return null;
  }

  if (input.key === "ArrowLeft" && navigation.hasPrevious) {
    return { type: "previous" };
  }
  if (input.key === "ArrowRight" && navigation.hasNext) {
    return { type: "next" };
  }
  return null;
}
