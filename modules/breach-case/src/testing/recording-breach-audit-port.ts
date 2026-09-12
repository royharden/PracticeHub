import type {
  AuditScopeQueryV1,
  AuditScopeResultV1,
  BreachAuditAppendInputV1,
  BreachAuditPortV1,
} from '../ports.js';

export class RecordingBreachAuditPortV1 implements BreachAuditPortV1 {
  public readonly version = 'v1' as const;
  public readonly scopeQueries: AuditScopeQueryV1[] = [];
  public readonly auditAppends: BreachAuditAppendInputV1[] = [];
  public readonly retentionBindings: Array<{
    readonly tenantId: string;
    readonly caseId: string;
    readonly evidenceRefs: readonly string[];
    readonly occurredAt: string;
    readonly idempotencyKey: string;
  }> = [];

  public constructor(private readonly scopeResult: AuditScopeResultV1) {}

  public async queryAffectedScope(input: AuditScopeQueryV1): Promise<AuditScopeResultV1> {
    this.scopeQueries.push(input);
    return { ...this.scopeResult, subjectRefs: [...this.scopeResult.subjectRefs] };
  }

  public async appendCaseAudit(
    input: BreachAuditAppendInputV1,
  ): Promise<{ readonly auditRecordRef: string }> {
    this.auditAppends.push(input);
    return { auditRecordRef: `audit-record:${input.caseId}-${this.auditAppends.length}` };
  }

  public async bindRetention(input: {
    readonly tenantId: string;
    readonly caseId: string;
    readonly evidenceRefs: readonly string[];
    readonly occurredAt: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly retentionEvidenceRef: string }> {
    this.retentionBindings.push(input);
    return { retentionEvidenceRef: `retention:${input.caseId}` };
  }
}
