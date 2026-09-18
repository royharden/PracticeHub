import type { TouchpointDefinition, TouchpointId, TenantId } from './types.js';
import { KillSwitchError } from './types.js';

export class TouchpointRegistry {
  private readonly rows = new Map<string, TouchpointDefinition>();

  public register(definition: TouchpointDefinition): void {
    if (!definition.memberFacing) {
      throw new KillSwitchError(
        'only member-facing touchpoints are instrumented',
        'not-member-facing',
      );
    }
    this.rows.set(
      key(definition.tenantId, definition.touchpointId),
      Object.freeze({ ...definition }),
    );
  }

  public get(tenantId: TenantId, touchpointId: TouchpointId): TouchpointDefinition | undefined {
    return this.rows.get(key(tenantId, touchpointId));
  }

  public require(tenantId: TenantId, touchpointId: TouchpointId): TouchpointDefinition {
    const found = this.get(tenantId, touchpointId);
    if (found === undefined) {
      throw new KillSwitchError('unknown touchpoint', 'unknown-touchpoint');
    }
    return found;
  }
}

function key(tenantId: TenantId, touchpointId: TouchpointId): string {
  return `${tenantId}\0${touchpointId}`;
}
