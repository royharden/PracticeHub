import {
  closeBreachCase,
  completeGeneticTargetedReview,
  linkJurisdictionDuty,
  linkRetentionEvidence,
  openBreachCase,
  openGeneticTargetedReview,
  recordAffectedScope,
  recordDetermination,
  recordFourFactorAssessment,
  recordNotice,
  updateJurisdictionDuty,
  type BreachCaseAggregate,
} from './breach-case.js';
import { breachEventIntentHash } from './breach-case-store.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

function buildNorthwindSeed(): BreachCaseAggregate {
  let aggregate = openBreachCase({
    tenantId: northwind,
    caseId: 'synthetic-breach-reportable',
    sourceKind: 'genetic-break-glass',
    sourceRef: 'incident:synthetic-genetic-disclosure',
    incidentAt: '2026-03-01T09:00:00Z',
    discoveryAt: '2026-03-02T10:00:00Z',
    ownerRef: 'compliance:privacy-officer',
    actorRef: 'system:breach-intake',
    eventKey: 'seed-nw-open',
  });
  aggregate = recordAffectedScope(aggregate, {
    subjectRefs: ['person:synthetic-patient-1'],
    queryEvidenceRef: 'audit-query:synthetic-scope-1',
    windowStart: '2026-03-01T08:00:00Z',
    windowEnd: '2026-03-02T10:00:00Z',
    complete: true,
    limitationRef: null,
    recordedAt: '2026-03-02T10:15:00Z',
    actorRef: 'compliance:privacy-officer',
    eventKey: 'seed-nw-scope',
  });
  aggregate = recordFourFactorAssessment(aggregate, {
    assessmentId: 'synthetic-assessment-1',
    assessedAt: '2026-03-02T11:00:00Z',
    assessedBy: 'compliance:privacy-officer',
    actorRef: 'compliance:privacy-officer',
    eventKey: 'seed-nw-assessment',
    nature: {
      phiCategoryRefs: ['phi-category:genetic'],
      extent: 'limited',
      evidenceRefs: ['evidence:synthetic-nature'],
    },
    recipient: {
      recipientClass: 'vendor',
      relationshipRef: 'vendor:synthetic-labs',
      evidenceRefs: ['evidence:synthetic-recipient'],
    },
    acquisition: { state: 'viewed', evidenceRefs: ['evidence:synthetic-viewed'] },
    mitigation: {
      state: 'partial',
      actionRefs: ['action:synthetic-link-disabled'],
      evidenceRefs: ['evidence:synthetic-mitigation'],
    },
  });
  aggregate = recordDetermination(aggregate, {
    kind: 'reportable',
    rationaleRef: 'rationale:synthetic-reportable',
    determinedBy: 'compliance:privacy-officer',
    approvedBy: 'owner:synthetic-cfo',
    determinedAt: '2026-03-02T12:00:00Z',
    eventKey: 'seed-nw-determination',
  });
  aggregate = linkJurisdictionDuty(
    aggregate,
    {
      dutyId: 'synthetic-floor-duty',
      clockId: 'clock:synthetic-floor-duty',
      jurisdiction: 'floor',
      contributionFact: 'floor',
      policyVersion: 1,
      policyEffectiveOn: '2026-01-01',
      policyRef: 'policy:synthetic-breach-floor-v1',
      dueAt: '2026-05-01T10:00:00Z',
      escalationAt: '2026-04-24T10:00:00Z',
      requiredAudiences: ['individual'],
      status: 'open',
      completionEvidenceRef: null,
      synthetic: true,
    },
    'system:clock-consumer',
    'seed-nw-duty',
    '2026-03-02T12:05:00Z',
  );
  aggregate = recordNotice(
    aggregate,
    {
      noticeId: 'synthetic-notice-1',
      dutyId: 'synthetic-floor-duty',
      audience: 'individual',
      payloadRef: 'payload:synthetic-notice-1',
      preparedBy: 'compliance:notice-author',
      preparedAt: '2026-03-03T09:00:00Z',
      approvedBy: null,
      approvedAt: null,
      effectIntentKey: null,
      effectKey: null,
      state: 'prepared',
      terminalEvidenceRef: null,
      synthetic: true,
    },
    'compliance:notice-author',
    'seed-nw-notice-prepared',
    '2026-03-03T09:00:00Z',
  );
  const prepared = aggregate.notices[0];
  if (prepared === undefined) throw new Error('synthetic prepared notice missing');
  aggregate = recordNotice(
    aggregate,
    {
      ...prepared,
      approvedBy: 'owner:synthetic-cfo',
      approvedAt: '2026-03-03T10:00:00Z',
      state: 'approved',
    },
    'owner:synthetic-cfo',
    'seed-nw-notice-approved',
    '2026-03-03T10:00:00Z',
  );
  const approved = aggregate.notices[0];
  if (approved === undefined) throw new Error('synthetic approved notice missing');
  aggregate = recordNotice(
    aggregate,
    {
      ...approved,
      effectIntentKey: 'notice-intent:synthetic-notice-1',
      state: 'effect-intended',
    },
    'owner:synthetic-cfo',
    'seed-nw-notice-effect-intended',
    '2026-03-03T10:00:30Z',
  );
  const intended = aggregate.notices[0];
  if (intended === undefined) throw new Error('synthetic effect intent missing');
  aggregate = recordNotice(
    aggregate,
    {
      ...intended,
      effectKey: 'effect:synthetic-notice-1',
      state: 'accepted',
    },
    'system:notification-consumer',
    'seed-nw-notice-accepted',
    '2026-03-03T10:01:00Z',
  );
  const accepted = aggregate.notices[0];
  if (accepted === undefined) throw new Error('synthetic accepted notice missing');
  aggregate = recordNotice(
    aggregate,
    {
      ...accepted,
      state: 'delivered',
      terminalEvidenceRef: 'receipt:synthetic-delivered-1',
    },
    'system:notification-reconciler',
    'seed-nw-notice-delivered',
    '2026-03-03T10:02:00Z',
  );
  aggregate = openGeneticTargetedReview(
    aggregate,
    {
      tenantId: northwind,
      sourceEventKey: 'seed-nw-genetic-open',
      grantRef: 'break-glass-grant:synthetic-1',
      auditRef: 'audit-record:synthetic-break-glass-1',
      workItemRef: 'work-item:synthetic-genetic-review-1',
      accessorRef: 'person:synthetic-accessor',
      initiatorRef: 'person:synthetic-initiator',
      subjectRef: 'person:synthetic-patient-1',
      severity: 'elevated-genetic',
      partitionTags: ['gipa-genetic'],
      reviewDueAt: '2026-03-04T10:00:00Z',
      occurredAt: '2026-03-02T10:00:00Z',
      synthetic: true,
    },
    'system:identity-consumer',
  );
  aggregate = completeGeneticTargetedReview(aggregate, {
    reviewId: 'genetic-review-seed-nw-genetic-open',
    reviewerRef: 'person:synthetic-reviewer',
    disposition: 'insufficient-justification',
    evidenceRef: 'evidence:synthetic-genetic-review',
    completedAt: '2026-03-03T12:00:00Z',
    eventKey: 'seed-nw-genetic-complete',
  });
  aggregate = linkRetentionEvidence(
    aggregate,
    'audit-record:synthetic-breach-case',
    'retention:synthetic-breach-case',
    'system:audit-consumer',
    'seed-nw-retention',
    '2026-03-03T12:05:00Z',
  );
  aggregate = updateJurisdictionDuty(
    aggregate,
    'synthetic-floor-duty',
    'satisfied',
    'clock-event:synthetic-satisfied',
    'system:clock-consumer',
    'seed-nw-duty-satisfied',
    '2026-03-03T12:10:00Z',
  );
  return closeBreachCase(aggregate, {
    actorRef: 'compliance:privacy-officer',
    occurredAt: '2026-03-03T13:00:00Z',
    evidenceRef: 'evidence:synthetic-closure',
    eventKey: 'seed-nw-close',
  });
}

function buildRiverbendSeed(): BreachCaseAggregate {
  return openBreachCase({
    tenantId: riverbend,
    caseId: 'synthetic-breach-assessing',
    sourceKind: 'wrong-disclosure',
    sourceRef: 'incident:synthetic-riverbend-disclosure',
    incidentAt: '2026-03-05T09:00:00Z',
    discoveryAt: '2026-03-06T09:00:00Z',
    ownerRef: 'compliance:riverbend-officer',
    actorRef: 'system:merge-consumer',
    eventKey: 'seed-rb-open',
  });
}

export const syntheticBreachCaseSeedV1 = {
  aggregates: [buildNorthwindSeed(), buildRiverbendSeed()],
} as const;

export const breachCaseSeedBeginMarker = '-- breach-case:generated:begin';
export const breachCaseSeedEndMarker = '-- breach-case:generated:end';

const sql = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const nullable = (value: string | null): string => (value === null ? 'NULL' : sql(value));
const json = (value: unknown): string => `${sql(JSON.stringify(value))}::jsonb`;
const bool = (value: boolean): string => (value ? 'true' : 'false');

function valuesStatement(
  table: string,
  columns: string,
  rows: readonly string[],
  conflict: string,
): string[] {
  if (rows.length === 0) return [];
  return [`INSERT INTO ${table} (${columns})`, 'VALUES', rows.join(',\n'), conflict, ''];
}

export function renderBreachCaseSeedSection(): string {
  const aggregates = [...syntheticBreachCaseSeedV1.aggregates].sort((left, right) =>
    `${left.tenantId}|${left.caseId}`.localeCompare(`${right.tenantId}|${right.caseId}`),
  );
  const events = aggregates.flatMap((aggregate) => aggregate.events);
  const rows: string[] = [
    breachCaseSeedBeginMarker,
    '-- Generated by @practicehub/breach-case renderBreachCaseSeedSection.',
    '-- Synthetic only; event payloads remain the reconstructible source of truth.',
    'BEGIN;',
    '',
  ];
  rows.push(
    ...valuesStatement(
      'breach_case.breach_case',
      'tenant_id,case_id,source_kind,source_ref,incident_at,discovery_at,owner_ref,status,current_assessment_version,current_scope_version,determination,strictest_due_at,retention_evidence_ref,closure_evidence_ref,last_event_seq,synthetic',
      aggregates.map((aggregate) => {
        const closed =
          aggregate.status === 'closed' ? (aggregate.events.at(-1)?.evidenceRef ?? null) : null;
        return `  (${sql(aggregate.tenantId)},${sql(aggregate.caseId)},${sql(aggregate.sourceKind)},${sql(aggregate.sourceRef)},${sql(aggregate.incidentAt)}::timestamptz,${sql(aggregate.discoveryAt)}::timestamptz,${sql(aggregate.ownerRef)},${sql(aggregate.status)},${String(aggregate.assessments.at(-1)?.version ?? 'NULL')},${String(aggregate.affectedScopes.at(-1)?.version ?? 'NULL')},${aggregate.determination === null ? 'NULL' : json(aggregate.determination)},${nullable(aggregate.strictestOpenDueAt)},${nullable(aggregate.retentionEvidenceRef)},${nullable(closed)},${aggregate.lastEventSeq},true)`;
      }),
      'ON CONFLICT (tenant_id,case_id) DO NOTHING;',
    ),
    ...valuesStatement(
      'breach_case.breach_case_event',
      'tenant_id,case_id,event_seq,event_key,event_type,occurred_at,actor_ref,payload,payload_hash,synthetic',
      events.map(
        (event) =>
          `  (${sql(event.tenantId)},${sql(event.caseId)},${event.eventSeq},${sql(event.eventKey)},${sql(event.eventType)},${sql(event.occurredAt)}::timestamptz,${sql(event.actorRef)},${json(event)},${sql(breachEventIntentHash(event))},true)`,
      ),
      'ON CONFLICT (tenant_id,case_id,event_seq) DO NOTHING;',
    ),
  );
  const assessments = events.flatMap((event) =>
    event.assessment === undefined ? [] : [{ event, value: event.assessment }],
  );
  rows.push(
    ...valuesStatement(
      'breach_case.factor_assessment',
      'tenant_id,case_id,assessment_id,version,event_seq,event_type,scope_version,assessed_at,assessed_by,assessment,complete,synthetic',
      assessments.map(
        ({ event, value }) =>
          `  (${sql(event.tenantId)},${sql(event.caseId)},${sql(value.assessmentId)},${value.version},${event.eventSeq},${sql(event.eventType)},${value.scopeVersion},${sql(value.assessedAt)}::timestamptz,${sql(value.assessedBy)},${json(value)},${bool(value.complete)},true)`,
      ),
      'ON CONFLICT (tenant_id,case_id,version) DO NOTHING;',
    ),
  );
  const scopes = events.flatMap((event) =>
    event.scope === undefined ? [] : [{ event, value: event.scope }],
  );
  rows.push(
    ...valuesStatement(
      'breach_case.affected_scope_version',
      'tenant_id,case_id,version,event_seq,event_type,content_hash,query_evidence_ref,window_start,window_end,complete,limitation_ref,recorded_at,synthetic',
      scopes.map(
        ({ event, value }) =>
          `  (${sql(event.tenantId)},${sql(event.caseId)},${value.version},${event.eventSeq},${sql(event.eventType)},${sql(value.contentHash)},${sql(value.queryEvidenceRef)},${sql(value.windowStart)}::timestamptz,${sql(value.windowEnd)}::timestamptz,${bool(value.complete)},${nullable(value.limitationRef)},${sql(value.recordedAt)}::timestamptz,true)`,
      ),
      'ON CONFLICT (tenant_id,case_id,version) DO NOTHING;',
    ),
  );
  rows.push(
    ...valuesStatement(
      'breach_case.affected_subject',
      'tenant_id,case_id,scope_version,subject_ref,synthetic',
      scopes.flatMap(({ event, value }) =>
        value.subjectRefs.map(
          (subjectRef) =>
            `  (${sql(event.tenantId)},${sql(event.caseId)},${value.version},${sql(subjectRef)},true)`,
        ),
      ),
      'ON CONFLICT DO NOTHING;',
    ),
  );
  const latestDuties = aggregates.flatMap((aggregate) =>
    aggregate.duties.map((value) => ({
      aggregate,
      value,
      event: aggregate.events.findLast((event) => event.duty?.dutyId === value.dutyId),
    })),
  );
  rows.push(
    ...valuesStatement(
      'breach_case.jurisdiction_duty',
      'tenant_id,case_id,duty_id,event_seq,event_type,clock_id,jurisdiction,contribution_fact,policy_version,policy_effective_on,policy_ref,due_at,escalation_at,required_audiences,status,completion_evidence_ref,synthetic',
      latestDuties.map(({ aggregate, value, event }) => {
        if (event === undefined) throw new Error('seeded duty event missing');
        return `  (${sql(aggregate.tenantId)},${sql(aggregate.caseId)},${sql(value.dutyId)},${event.eventSeq},${sql(event.eventType)},${sql(value.clockId)},${sql(value.jurisdiction)},${sql(value.contributionFact)},${value.policyVersion},${sql(value.policyEffectiveOn)}::date,${sql(value.policyRef)},${sql(value.dueAt)}::timestamptz,${sql(value.escalationAt)}::timestamptz,ARRAY[${value.requiredAudiences.map(sql).join(',')}]::text[],${sql(value.status)},${nullable(value.completionEvidenceRef)},true)`;
      }),
      'ON CONFLICT (tenant_id,case_id,duty_id) DO NOTHING;',
    ),
  );
  const notices = events.flatMap((event) =>
    event.notice === undefined ? [] : [{ event, value: event.notice }],
  );
  rows.push(
    ...valuesStatement(
      'breach_case.notification_evidence',
      'tenant_id,case_id,notice_id,event_seq,event_type,duty_id,audience,payload_ref,prepared_by,prepared_at,approved_by,approved_at,effect_intent_key,effect_key,transport_state,terminal_evidence_ref,synthetic',
      notices.map(
        ({ event, value }) =>
          `  (${sql(event.tenantId)},${sql(event.caseId)},${sql(value.noticeId)},${event.eventSeq},${sql(event.eventType)},${sql(value.dutyId)},${sql(value.audience)},${sql(value.payloadRef)},${sql(value.preparedBy)},${sql(value.preparedAt)}::timestamptz,${nullable(value.approvedBy)},${nullable(value.approvedAt)},${nullable(value.effectIntentKey)},${nullable(value.effectKey)},${sql(value.state)},${nullable(value.terminalEvidenceRef)},true)`,
      ),
      'ON CONFLICT DO NOTHING;',
    ),
  );
  const reviews = events.flatMap((event) =>
    event.geneticReview === undefined ? [] : [{ event, value: event.geneticReview }],
  );
  rows.push(
    ...valuesStatement(
      'breach_case.genetic_targeted_review',
      'tenant_id,case_id,review_id,event_seq,event_type,grant_ref,audit_ref,work_item_ref,accessor_ref,initiator_ref,subject_ref,review_due_at,source_occurred_at,risk,reviewer_ref,disposition,evidence_ref,completed_at,synthetic',
      reviews.map(
        ({ event, value }) =>
          `  (${sql(event.tenantId)},${sql(event.caseId)},${sql(value.reviewId)},${event.eventSeq},${sql(event.eventType)},${sql(value.grantRef)},${sql(value.auditRef)},${sql(value.workItemRef)},${sql(value.accessorRef)},${sql(value.initiatorRef)},${sql(value.subjectRef)},${sql(value.reviewDueAt)}::timestamptz,${sql(value.sourceOccurredAt)}::timestamptz,${sql(value.risk)},${nullable(value.reviewerRef)},${nullable(value.disposition)},${nullable(value.evidenceRef)},${nullable(value.completedAt)},true)`,
      ),
      'ON CONFLICT DO NOTHING;',
    ),
  );
  rows.push(
    ...valuesStatement(
      'breach_case.effect_fence',
      'tenant_id,event_key,case_id,intent_hash,created_at,synthetic',
      events.map(
        (event) =>
          `  (${sql(event.tenantId)},${sql(event.eventKey)},${sql(event.caseId)},${sql(breachEventIntentHash(event))},${sql(event.occurredAt)}::timestamptz,true)`,
      ),
      'ON CONFLICT (tenant_id,event_key) DO NOTHING;',
    ),
  );
  rows.push('COMMIT;', breachCaseSeedEndMarker);
  return rows.join('\n');
}

export function extractBreachCaseSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(breachCaseSeedBeginMarker);
  const end = seedSql.indexOf(breachCaseSeedEndMarker);
  if (begin === -1 || end < begin) return null;
  return seedSql.slice(begin, end + breachCaseSeedEndMarker.length);
}
