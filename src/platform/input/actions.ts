export interface InputPoint {
  x: number;
  y: number;
}

export type SelectionInputMode = "replace" | "toggle";

export type ViewerInputAction =
  | { type: "pan"; delta: InputPoint }
  | { type: "zoom"; factor: number; anchor: InputPoint }
  | { type: "activate-at"; point: InputPoint }
  | { type: "back" }
  | { type: "previous" }
  | { type: "next" }
  | { type: "select-at"; point: InputPoint; mode: SelectionInputMode };
