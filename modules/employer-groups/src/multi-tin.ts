import type { EmployerGroup, Tin } from './types.js';
import { EmployerGroupError } from './types.js';

export class MultiTinRegistry {
  private readonly groups = new Map<string, EmployerGroup>();

  public register(group: EmployerGroup): void {
    if (group.tins.length === 0) {
      throw new EmployerGroupError('employer requires at least one TIN', 'missing-tin');
    }
    const seen = new Set<string>();
    for (const tin of group.tins) {
      if (seen.has(tin)) {
        throw new EmployerGroupError('duplicate TIN', 'duplicate-tin');
      }
      seen.add(tin);
    }
    this.groups.set(group.employerRef, Object.freeze({ ...group, tins: [...group.tins] }));
  }

  public require(employerRef: string): EmployerGroup {
    const found = this.groups.get(employerRef);
    if (found === undefined) {
      throw new EmployerGroupError('unknown employer', 'unknown-employer');
    }
    return found;
  }

  public ownsTin(employerRef: string, tin: Tin): boolean {
    return this.require(employerRef).tins.includes(tin);
  }
}
