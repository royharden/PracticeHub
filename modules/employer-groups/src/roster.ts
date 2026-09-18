import type { MultiTinRegistry } from './multi-tin.js';
import type { RosterDiff, RosterRow, RowError } from './types.js';
import { EmployerGroupError } from './types.js';
import type { Wp053EntitlementsDouble } from './wp053-entitlements-double.js';

export class RosterStore {
  private readonly active = new Map<string, RosterRow>();
  private readonly history: RosterDiff[] = [];
  private pending: RosterDiff | undefined;
  public readonly mspQueue: string[] = [];

  public constructor(
    private readonly registry: MultiTinRegistry,
    private readonly entitlements: Wp053EntitlementsDouble,
  ) {}

  public preview(employerRef: string, incoming: readonly RosterRow[]): RosterDiff {
    const group = this.registry.require(employerRef);
    const errors: RowError[] = [];
    const valid: RosterRow[] = [];
    const seen = new Set<string>();
    for (const row of incoming) {
      const reason = this.#validate(employerRef, row, seen);
      if (reason !== undefined) {
        errors.push({ employeeId: row.employeeId, reason, synthetic: true });
        continue;
      }
      seen.add(row.employeeId);
      valid.push(row);
    }
    const current = [...this.active.values()];
    const currentIds = new Set(current.map((row) => row.employeeId));
    const nextIds = new Set(valid.map((row) => row.employeeId));
    const additions = valid.filter((row) => !currentIds.has(row.employeeId));
    const terminations = current.filter((row) => !nextIds.has(row.employeeId));
    const changes = valid.filter((row) => {
      const prior = this.active.get(row.employeeId);
      return prior !== undefined && JSON.stringify(prior) !== JSON.stringify(row);
    });
    const alreadyEnrolledCount = valid.filter((row) => currentIds.has(row.employeeId)).length;
    const headcountVariance =
      Math.abs(valid.filter((row) => row.status === 'active').length - group.committedHeadcount) >=
      1;
    const diff: RosterDiff = Object.freeze({
      additions,
      terminations,
      changes,
      errors,
      invitedCount: additions.length,
      heldCount: errors.length,
      alreadyEnrolledCount,
      headcountVariance,
      confirmed: false,
      synthetic: true,
    });
    this.pending = diff;
    return diff;
  }

  public confirm(employerRef: string, at: string): RosterDiff {
    if (this.pending === undefined) {
      throw new EmployerGroupError('no staged roster diff', 'no-pending');
    }
    this.registry.require(employerRef);
    for (const row of this.pending.additions) {
      this.active.set(row.employeeId, row);
      if (row.medicareEligible) {
        this.mspQueue.push(row.employeeId);
      } else {
        this.entitlements.grant({
          tenantId: this.registry.require(employerRef).tenantId,
          eventId: `grant:${row.employeeId}`,
          memberRef: row.employeeId,
          componentRef: 'sponsored-eligibility',
          entitlementKind: 'sponsored',
          authorityJournalId: `roster:${at}`,
          idempotencyKey: `grant:${row.employeeId}`,
        });
      }
    }
    for (const row of this.pending.changes) {
      this.active.set(row.employeeId, row);
    }
    for (const row of this.pending.terminations) {
      this.active.delete(row.employeeId);
      this.entitlements.reverse({
        tenantId: this.registry.require(employerRef).tenantId,
        eventId: `rev:${row.employeeId}`,
        memberRef: row.employeeId,
        componentRef: 'sponsored-eligibility',
        entitlementKind: 'sponsored',
        authorityJournalId: `roster:${at}`,
        idempotencyKey: `rev:${row.employeeId}`,
        reversalOfEventId: `grant:${row.employeeId}`,
      });
    }
    const applied: RosterDiff = Object.freeze({ ...this.pending, confirmed: true });
    this.history.push(applied);
    this.pending = undefined;
    return applied;
  }

  public activeRows(): readonly RosterRow[] {
    return [...this.active.values()];
  }

  public lastDiff(): RosterDiff | undefined {
    return this.history.at(-1);
  }

  #validate(employerRef: string, row: RosterRow, seen: Set<string>): string | undefined {
    if (!row.name || !row.dob || !row.employeeId || !row.tier || !row.effectiveDate) {
      return 'missing-required-field';
    }
    if (!this.registry.ownsTin(employerRef, row.tin)) {
      return 'tin-not-on-employer';
    }
    if (seen.has(row.employeeId)) {
      return 'duplicate-in-file';
    }
    return undefined;
  }
}
