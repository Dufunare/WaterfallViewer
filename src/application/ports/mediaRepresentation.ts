export interface ThumbnailRequest {
  resourceKey: string;
  maxEdge: number;
}

export interface ThumbnailRepresentation {
  resourceKey: string;
  width: number;
  height: number;
}

export interface MediaRepresentationPort {
  /**
   * Request a derived thumbnail representation.
   *
   * `signal` represents backend work interest rather than one UI consumer. A
   * scheduler may share one backend request across multiple consumers and only
   * abort it after the final consumer leaves.
   */
  requestThumbnail(
    request: ThumbnailRequest,
    signal?: AbortSignal,
  ): Promise<ThumbnailRepresentation>;

  /**
   * Release one backend registration for a derived representation.
   *
   * Adapters that do not own releasable native resources may omit this method;
   * the scheduler then treats release as a no-op. Tauri implements it so native
   * protocol registrations can follow actual consumer leases.
   */
  releaseRepresentation?(resourceKey: string): Promise<void>;
}
