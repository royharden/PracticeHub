import type { Queryable } from '@practicehub/events';

import type { ContainmentPort, ContainmentRecord } from './ports.js';

interface ContainmentRow {
  readonly tenant_id: string;
  readonly use_case: string;
  readonly cohort_ref: string;
  readonly binding_ref: string;
  readonly incident_ref: string;
  readonly fallback_ref: string;
  readonly reason: string;
  readonly contained_at: string | Date;
  readonly synthetic: boolean;
}

/** Transaction-bound exact-cohort containment repository. */
export class PostgresContainmentPort implements ContainmentPort {
  public constructor(private readonly exec: Queryable) {}

  public async current(
    scope: Parameters<ContainmentPort['current']>[0],
  ): Promise<ContainmentRecord | null> {
    const result = await this.exec.query(
      `SELECT tenant_id, use_case, cohort_ref, binding_ref, incident_ref, fallback_ref,
              reason, contained_at, synthetic
         FROM ai_gateway.cohort_containment
        WHERE tenant_id = $1 AND use_case = $2 AND cohort_ref = $3 AND binding_ref = $4`,
      [scope.tenantId, scope.useCase, scope.cohortRef, scope.bindingRef],
    );
    const row = result.rows[0] as unknown as ContainmentRow | undefined;
    if (row === undefined) return null;
    return {
      tenantId: scope.tenantId,
      useCase: row.use_case,
      cohortRef: row.cohort_ref,
      bindingRef: row.binding_ref,
      incidentRef: row.incident_ref,
      fallbackRef: row.fallback_ref,
      reason: row.reason,
      containedAt:
        row.contained_at instanceof Date ? row.contained_at.toISOString() : row.contained_at,
      synthetic: true,
    };
  }

  public async kill(record: ContainmentRecord): Promise<void> {
    await this.exec.query(
      `INSERT INTO ai_gateway.cohort_containment
       (tenant_id,use_case,cohort_ref,binding_ref,incident_ref,fallback_ref,reason,contained_at,synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,true)
       ON CONFLICT (tenant_id,use_case,cohort_ref,binding_ref) DO UPDATE SET
         incident_ref = EXCLUDED.incident_ref,
         fallback_ref = EXCLUDED.fallback_ref,
         reason = EXCLUDED.reason,
         contained_at = EXCLUDED.contained_at,
         synthetic = true`,
      [
        record.tenantId,
        record.useCase,
        record.cohortRef,
        record.bindingRef,
        record.incidentRef,
        record.fallbackRef,
        record.reason,
        record.containedAt,
      ],
    );
  }
}
