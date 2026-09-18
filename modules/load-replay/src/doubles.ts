import { drillRegistryDoubleVersion, type DrillRegistryDouble } from './ports.js';

export class RecordingDrillRegistry implements DrillRegistryDouble {
  public readonly interfaceVersion = drillRegistryDoubleVersion;
  public readonly outcomes: Array<{
    readonly drillId: string;
    readonly outcome: 'green' | 'blocked';
  }> = [];
  public record(drillId: string, outcome: 'green' | 'blocked'): void {
    this.outcomes.push({ drillId, outcome });
  }
}
