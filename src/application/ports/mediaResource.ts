export interface MediaResourcePort {
  /** Resolve a platform-issued opaque resource handle into a renderer-consumable URI. */
  uriFor(resourceKey: string): string;
}
