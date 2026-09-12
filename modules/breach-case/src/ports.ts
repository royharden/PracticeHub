import {
  linkJurisdictionDuty,
  linkRetentionEvidence,
  openGeneticTargetedReview,
  recordAffectedScope,
  recordNotice,
  BreachCaseError,
  type BreachCaseAggregate,
  type GeneticElevationSourceRecord,
  type JurisdictionDuty,
  type NoticeAudience,
} from './breach-case.js';

const portIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertPortId(value: string, label: string): void {
  if (!portIdPattern.test(value)) throw new BreachCaseError(`${label} must use id grammar`);
}

function assertPortInstant(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) throw new BreachCaseError(`${label} must be an ISO instant`);
}

export interface BreachClockOpenInputV1 {
  readonly tenantId: string;
  readonly caseId: string;
  readonly discoveryAt: string;
  readonly providerState: string | null;
  readonly affectedPatientStates: readonly string[];
  readonly triggerRef: string;
  readonly idempotencyKey: string;
}

export interface BreachClockMutationInputV1 {
  readonly tenantId: string;
  readonly caseId: string;
  readonly dutyId: string;
  readonly clockId: string;
  readonly occurredAt: string;
  readonly evidenceRef: string;
  readonly idempotencyKey: string;
}

export interface BreachClockPortV1 {
  readonly version: 'v1';
  openNotificationDuties(input: BreachClockOpenInputV1): Promise<readonly JurisdictionDuty[]>;
  escalate(input: BreachClockMutationInputV1): Promise<{ readonly clockEventRef: string }>;
  satisfy(input: BreachClockMutationInputV1): Promise<{ readonly clockEventRef: string }>;
  cancelWithEvidence(
    input: BreachClockMutationInputV1,
  ): Promise<{ readonly clockEventRef: string }>;
}

export interface AuditScopeQueryV1 {
  readonly tenantId: string;
  readonly caseId: string;
  readonly sourceRef: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface AuditScopeResultV1 {
  readonly subjectRefs: readonly string[];
  readonly queryEvidenceRef: string;
  readonly complete: boolean;
  readonly limitationRef: string | null;
}

export interface BreachAuditAppendInputV1 {
  readonly tenantId: string;
  readonly caseId: string;
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly sourceRef: string;
  readonly correlationRef: string;
  readonly detailRefs: Readonly<Record<string, string>>;
}

export interface BreachAuditPortV1 {
  readonly version: 'v1';
  queryAffectedScope(input: AuditScopeQueryV1): Promise<AuditScopeResultV1>;
  appendCaseAudit(input: BreachAuditAppendInputV1): Promise<{ readonly auditRecordRef: string }>;
  bindRetention(input: {
    readonly tenantId: string;
    readonly caseId: string;
    readonly evidenceRefs: readonly string[];
    readonly occurredAt: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly retentionEvidenceRef: string }>;
}

export interface NoticePrepareInputV1 {
  readonly tenantId: string;
  readonly caseId: string;
  readonly dutyId: string;
  readonly audience: NoticeAudience;
  readonly preparedBy: string;
  readonly preparedAt: string;
  readonly templateRef: string;
  readonly idempotencyKey: string;
}

export interface NoticeSendInputV1 {
  readonly tenantId: string;
  readonly caseId: string;
  readonly noticeId: string;
  readonly dutyId: string;
  readonly audience: NoticeAudience;
  readonly payloadRef: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly idempotencyKey: string;
}

export interface NoticeReconcileInputV1 {
  readonly tenantId: string;
  readonly caseId: string;
  readonly noticeId: string;
  readonly effectKey: string;
  readonly receiptEventKey: string;
  readonly observedAt: string;
}

export interface BreachNotificationPortV1 {
  readonly version: 'v1';
  prepare(
    input: NoticePrepareInputV1,
  ): Promise<{ readonly noticeId: string; readonly payloadRef: string }>;
  sendApproved(input: NoticeSendInputV1): Promise<{
    readonly effectKey: string;
    readonly state: 'accepted' | 'unknown' | 'delivered' | 'failed';
    readonly terminalEvidenceRef: string | null;
  }>;
  reconcile(input: NoticeReconcileInputV1): Promise<{
    readonly state: 'delivered' | 'failed' | 'unknown';
    readonly terminalEvidenceRef: string | null;
  }>;
}

export interface GeneticElevationSourceV1 {
  readonly version: 'v1';
  read(sourceEventKey: string): Promise<GeneticElevationSourceRecord | null>;
}

export async function openBreachCaseDependencies(
  aggregate: BreachCaseAggregate,
  dependencies: { readonly clocks: BreachClockPortV1; readonly audit: BreachAuditPortV1 },
  input: {
    readonly providerState: string | null;
    readonly affectedPatientStates: readonly string[];
    readonly actorRef: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly occurredAt: string;
    readonly idempotencyKey: string;
  },
): Promise<BreachCaseAggregate> {
  if (dependencies.clocks.version !== 'v1' || dependencies.audit.version !== 'v1') {
    throw new BreachCaseError('unsupported breach dependency port version');
  }
  const scope = await dependencies.audit.queryAffectedScope({
    tenantId: aggregate.tenantId,
    caseId: aggregate.caseId,
    sourceRef: aggregate.sourceRef,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  });
  let current = recordAffectedScope(aggregate, {
    ...scope,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    recordedAt: input.occurredAt,
    actorRef: input.actorRef,
    eventKey: `${input.idempotencyKey}-scope`,
  });
  const duties = await dependencies.clocks.openNotificationDuties({
    tenantId: current.tenantId,
    caseId: current.caseId,
    discoveryAt: current.discoveryAt,
    providerState: input.providerState,
    affectedPatientStates: [...new Set(input.affectedPatientStates)].sort(),
    triggerRef: current.sourceRef,
    idempotencyKey: `${input.idempotencyKey}-clocks`,
  });
  for (const [index, duty] of duties.entries()) {
    current = linkJurisdictionDuty(
      current,
      duty,
      input.actorRef,
      `${input.idempotencyKey}-duty-${index + 1}`,
      input.occurredAt,
    );
  }
  const audit = await dependencies.audit.appendCaseAudit({
    tenantId: current.tenantId,
    caseId: current.caseId,
    action: 'breach-case-opened',
    actorRef: input.actorRef,
    occurredAt: input.occurredAt,
    sourceRef: current.sourceRef,
    correlationRef: `breach-case:${current.caseId}`,
    detailRefs: { scope: scope.queryEvidenceRef },
  });
  const retention = await dependencies.audit.bindRetention({
    tenantId: current.tenantId,
    caseId: current.caseId,
    evidenceRefs: [scope.queryEvidenceRef, audit.auditRecordRef],
    occurredAt: input.occurredAt,
    idempotencyKey: `${input.idempotencyKey}-retention`,
  });
  return linkRetentionEvidence(
    current,
    audit.auditRecordRef,
    retention.retentionEvidenceRef,
    input.actorRef,
    `${input.idempotencyKey}-audit`,
    input.occurredAt,
  );
}

export async function consumeGeneticElevation(
  aggregate: BreachCaseAggregate,
  source: GeneticElevationSourceV1,
  sourceEventKey: string,
  actorRef: string,
): Promise<BreachCaseAggregate> {
  if (source.version !== 'v1')
    throw new BreachCaseError('unsupported genetic elevation port version');
  assertPortId(sourceEventKey, 'sourceEventKey');
  const record = await source.read(sourceEventKey);
  if (record === null) return aggregate;
  if (record.sourceEventKey !== sourceEventKey) {
    throw new BreachCaseError('genetic source key does not match requested key');
  }
  if (record.synthetic !== true) throw new BreachCaseError('genetic source must be synthetic');
  return openGeneticTargetedReview(aggregate, record, actorRef);
}

export async function sendHumanApprovedNotice(
  aggregate: BreachCaseAggregate,
  port: BreachNotificationPortV1,
  input: NoticePrepareInputV1 & {
    readonly approvedBy: string;
    readonly approvedAt: string;
    readonly persistEffectIntent: (aggregate: BreachCaseAggregate) => Promise<void>;
  },
): Promise<BreachCaseAggregate> {
  if (port.version !== 'v1') throw new BreachCaseError('unsupported notification port version');
  if (input.tenantId !== aggregate.tenantId || input.caseId !== aggregate.caseId) {
    throw new BreachCaseError('notice input tenant/case mismatch');
  }
  if (input.approvedBy === input.preparedBy) {
    throw new BreachCaseError('notice approval must be independent');
  }
  assertPortId(input.idempotencyKey, 'notice idempotencyKey');
  assertPortInstant(input.preparedAt, 'preparedAt');
  assertPortInstant(input.approvedAt, 'approvedAt');
  if (Date.parse(input.approvedAt) < Date.parse(input.preparedAt)) {
    throw new BreachCaseError('notice approval cannot precede preparation');
  }
  if (!aggregate.duties.some((duty) => duty.dutyId === input.dutyId)) {
    throw new BreachCaseError('notice must name an applicable duty');
  }
  const prepared = await port.prepare(input);
  let current = recordNotice(
    aggregate,
    {
      noticeId: prepared.noticeId,
      dutyId: input.dutyId,
      audience: input.audience,
      payloadRef: prepared.payloadRef,
      preparedBy: input.preparedBy,
      preparedAt: input.preparedAt,
      approvedBy: null,
      approvedAt: null,
      effectIntentKey: null,
      effectKey: null,
      state: 'prepared',
      terminalEvidenceRef: null,
      synthetic: true,
    },
    input.preparedBy,
    `${input.idempotencyKey}-prepared`,
    input.preparedAt,
  );
  const preparedNotice = current.notices.find((notice) => notice.noticeId === prepared.noticeId);
  if (preparedNotice === undefined) throw new BreachCaseError('prepared notice was not projected');
  current = recordNotice(
    current,
    {
      ...preparedNotice,
      approvedBy: input.approvedBy,
      approvedAt: input.approvedAt,
      state: 'approved',
    },
    input.approvedBy,
    `${input.idempotencyKey}-approved`,
    input.approvedAt,
  );
  const approvedNotice = current.notices.find((notice) => notice.noticeId === prepared.noticeId);
  if (approvedNotice === undefined) throw new BreachCaseError('approved notice was not projected');
  const effectIntentKey = `notice-intent:${input.idempotencyKey}`;
  current = recordNotice(
    current,
    {
      ...approvedNotice,
      effectIntentKey,
      state: 'effect-intended',
    },
    input.approvedBy,
    `${input.idempotencyKey}-effect-intended`,
    input.approvedAt,
  );
  await input.persistEffectIntent(current);
  const sent = await port.sendApproved({
    tenantId: input.tenantId,
    caseId: input.caseId,
    noticeId: prepared.noticeId,
    dutyId: input.dutyId,
    audience: input.audience,
    payloadRef: prepared.payloadRef,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
    idempotencyKey: effectIntentKey,
  });
  const intended = current.notices.find((notice) => notice.noticeId === prepared.noticeId);
  if (intended === undefined) throw new BreachCaseError('effect intent was not projected');
  return recordNotice(
    current,
    {
      ...intended,
      effectKey: sent.effectKey,
      state: sent.state,
      terminalEvidenceRef: sent.terminalEvidenceRef,
    },
    input.approvedBy,
    `${input.idempotencyKey}-result`,
    input.approvedAt,
  );
}

export async function reconcileNotice(
  aggregate: BreachCaseAggregate,
  port: BreachNotificationPortV1,
  input: NoticeReconcileInputV1 & { readonly actorRef: string },
): Promise<BreachCaseAggregate> {
  if (port.version !== 'v1') throw new BreachCaseError('unsupported notification port version');
  if (input.tenantId !== aggregate.tenantId || input.caseId !== aggregate.caseId) {
    throw new BreachCaseError('notice reconciliation tenant/case mismatch');
  }
  assertPortId(input.receiptEventKey, 'receiptEventKey');
  assertPortInstant(input.observedAt, 'observedAt');
  const current = aggregate.notices.find((notice) => notice.noticeId === input.noticeId);
  if (current === undefined) throw new BreachCaseError('cannot reconcile an unknown notice');
  if (current.effectKey === null || current.effectKey !== input.effectKey) {
    throw new BreachCaseError('notice reconciliation effect key mismatch');
  }
  if (current.state !== 'accepted' && current.state !== 'unknown') {
    throw new BreachCaseError('only accepted or unknown notice transport can reconcile');
  }
  const result = await port.reconcile(input);
  return recordNotice(
    aggregate,
    {
      ...current,
      state: result.state,
      terminalEvidenceRef: result.terminalEvidenceRef,
    },
    input.actorRef,
    input.receiptEventKey,
    input.observedAt,
  );
}
