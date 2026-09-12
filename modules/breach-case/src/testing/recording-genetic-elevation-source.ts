import type { GeneticElevationSourceRecord } from '../breach-case.js';
import type { GeneticElevationSourceV1 } from '../ports.js';

export class RecordingGeneticElevationSourceV1 implements GeneticElevationSourceV1 {
  public readonly version = 'v1' as const;
  public readonly reads: string[] = [];

  public constructor(private readonly records: ReadonlyMap<string, GeneticElevationSourceRecord>) {}

  public async read(sourceEventKey: string): Promise<GeneticElevationSourceRecord | null> {
    this.reads.push(sourceEventKey);
    return this.records.get(sourceEventKey) ?? null;
  }
}
