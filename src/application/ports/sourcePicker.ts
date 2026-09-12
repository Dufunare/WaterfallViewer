import type { SourceDescriptor } from "./mediaScan";

export interface PickedSource {
  source: SourceDescriptor;
  displayName: string;
}

export interface SourcePickerPort {
  pickDirectory(): Promise<PickedSource | null>;
}
