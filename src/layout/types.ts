export interface ViewportSize {
  width: number;
  height: number;
}

/** Layout-facing visual data. Resource and filesystem details stay outside Layout Core. */
export interface MediaVisualInfo {
  mediaId: string;
  width: number;
  height: number;
}

export interface LayoutNode {
  mediaId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
