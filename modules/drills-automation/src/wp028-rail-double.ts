/** Owned WP-028 double. Rail heartbeat/silence only. Not sims/vendor-sim-kit. */
export type HeartbeatBand = 'quiet' | 'alarm';

export class Wp028RailDouble {
  private readonly last = new Map<string, HeartbeatBand>();

  public observe(railId: string, band: HeartbeatBand): void {
    this.last.set(railId, band);
  }

  public heartbeat(railId: string): HeartbeatBand {
    return this.last.get(railId) ?? 'alarm';
  }
}
