import { invoke } from "@tauri-apps/api/core";

import type {
  PickedSource,
  SourcePickerPort,
} from "../../application/ports/sourcePicker";

interface PickedSourceDto {
  sourceId: string;
  locator: string;
  displayName: string;
}

export class TauriSourcePickerPort implements SourcePickerPort {
  async pickDirectory(): Promise<PickedSource | null> {
    const picked = await invoke<PickedSourceDto | null>("pick_source_directory");
    if (picked === null) {
      return null;
    }

    if (
      picked.sourceId.trim().length === 0 ||
      picked.locator.trim().length === 0 ||
      picked.displayName.trim().length === 0
    ) {
      throw new Error("source picker returned an invalid source descriptor");
    }

    return {
      source: {
        id: picked.sourceId,
        locator: picked.locator,
      },
      displayName: picked.displayName,
    };
  }
}

export const tauriSourcePickerPort = new TauriSourcePickerPort();
