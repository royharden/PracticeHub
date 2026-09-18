import { createHash } from 'node:crypto';

import type {
  CohortBaseline,
  ImportFinding,
  MembershipVintageDouble,
  VintageRow,
  WorkbenchSnapshotDouble,
} from './types.js';
import { VintageImportError } from './types.js';

export class VintageImportRehearsal {
  #expectedChecksum: string | undefined;
  #observedChecksum: string | undefined;
  readonly #rows: VintageRow[] = [];
  readonly #cohorts = new Map<string, CohortBaseline>();
  readonly #batches = new Set<string>();

  public constructor(
    private readonly tenantId: string,
    private readonly workbench: WorkbenchSnapshotDouble,
    private readonly membership: MembershipVintageDouble,
  ) {}

  public freezeBaseline(bytes: Uint8Array, expectedChecksum: string): string {
    const observed = this.workbench.freeze({ tenantId: this.tenantId, bytes });
    this.#observedChecksum = observed;
    this.#expectedChecksum = expectedChecksum;
    return observed;
  }

  public addCohort(cohort: CohortBaseline): void {
    this.#cohorts.set(JSON.stringify([this.tenantId, cohort.cohortRef]), cohort);
  }

  public addRow(row: VintageRow): void {
    this.#rows.push(row);
  }

  public detect(): readonly ImportFinding[] {
    const findings: ImportFinding[] = [];
    if (this.#expectedChecksum === undefined || this.#observedChecksum === undefined) {
      throw new VintageImportError('BASELINE_REQUIRED');
    }
    if (this.#expectedChecksum !== this.#observedChecksum) {
      findings.push({
        findingRef: 'finding-baseline',
        tenantId: this.tenantId,
        code: 'CORRUPTED_BASELINE',
        severity: 'blocking',
        recordRef: null,
        synthetic: true,
      });
    }
    for (const row of this.#rows) {
      if (row.memberRef.length === 0 || row.vintageId.length === 0) {
        findings.push({
          findingRef: `finding-key-${row.recordRef}`,
          tenantId: this.tenantId,
          code: 'MISSING_KEY',
          severity: 'blocking',
          recordRef: row.recordRef,
          synthetic: true,
        });
        continue;
      }
      const cohort = this.#cohorts.get(JSON.stringify([this.tenantId, row.cohortRef]));
      if (
        cohort === undefined ||
        cohort.offerRef !== row.offerRef ||
        cohort.priceMinor !== row.priceMinor ||
        cohort.currency !== row.currency
      ) {
        findings.push({
          findingRef: `finding-cohort-${row.recordRef}`,
          tenantId: this.tenantId,
          code: 'COHORT_PRICE_DRIFT',
          severity: 'blocking',
          recordRef: row.recordRef,
          synthetic: true,
        });
      }
    }
    return findings;
  }

  public applyRehearsal(batchRef: string): number {
    const findings = this.detect();
    if (findings.some((finding) => finding.severity === 'blocking')) {
      throw new VintageImportError('APPLY_BLOCKED');
    }
    for (const row of this.#rows) {
      this.membership.apply({ tenantId: this.tenantId, batchRef, row });
    }
    this.#batches.add(JSON.stringify([this.tenantId, batchRef]));
    return this.#rows.length;
  }

  public rollbackBatch(batchRef: string): number {
    if (!this.#batches.has(JSON.stringify([this.tenantId, batchRef]))) {
      throw new VintageImportError('UNKNOWN_BATCH');
    }
    return this.membership.rollback({ tenantId: this.tenantId, batchRef });
  }
}

export function checksumBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
