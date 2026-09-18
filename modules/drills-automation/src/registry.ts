import type { DrillDefinition, DrillKind } from './types.js';
import { DrillError } from './types.js';

const KINDS: readonly DrillKind[] = ['failover', 'restore', 'kill-switch', 'degraded'];

export class DrillRegistry {
  private readonly rows = new Map<string, DrillDefinition>();

  public register(definition: DrillDefinition): void {
    if (!KINDS.includes(definition.kind)) {
      throw new DrillError('unknown drill kind', 'unknown-kind');
    }
    if (definition.cadenceMs <= 0) {
      throw new DrillError('cadence must be positive', 'cadence');
    }
    this.rows.set(definition.drillId, Object.freeze({ ...definition }));
  }

  public require(drillId: string): DrillDefinition {
    const found = this.rows.get(drillId);
    if (found === undefined) {
      throw new DrillError('unknown drill', 'unknown-drill');
    }
    return found;
  }

  public all(): readonly DrillDefinition[] {
    return [...this.rows.values()];
  }

  public kindsCovered(): readonly DrillKind[] {
    return KINDS.filter((kind) => [...this.rows.values()].some((row) => row.kind === kind));
  }
}
