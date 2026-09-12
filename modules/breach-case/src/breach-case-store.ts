import { createHash } from 'node:crypto';

import { foldBreachCase, type BreachCaseAggregate, type BreachCaseEvent } from './breach-case.js';

export interface QueryResultLike<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface BreachQueryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<Row>>;
}

function canonicalJson(value: unknown): string {
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    !Number.isNaN(Date.parse(value))
  ) {
    return JSON.stringify(new Date(value).toISOString());
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function breachEventIntentHash(event: BreachCaseEvent): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

export function normalizePostgresCalendarDate(value: unknown): string {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match !== null) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      if (month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth[month - 1] ?? 0)) {
        return value;
      }
    }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    if (
      value.getHours() !== 0 ||
      value.getMinutes() !== 0 ||
      value.getSeconds() !== 0 ||
      value.getMilliseconds() !== 0
    ) {
      throw new Error('policy_effective_on Date must represent exact local midnight');
    }
    const year = String(value.getFullYear()).padStart(4, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  throw new Error('policy_effective_on must be a PostgreSQL calendar date');
}

export function breachNormalizedSnapshot(aggregate: BreachCaseAggregate): {
  readonly assessments: readonly Record<string, unknown>[];
  readonly scopes: readonly Record<string, unknown>[];
  readonly subjects: readonly Record<string, unknown>[];
  readonly duties: readonly Record<string, unknown>[];
  readonly notices: readonly Record<string, unknown>[];
  readonly reviews: readonly Record<string, unknown>[];
  readonly fences: readonly Record<string, unknown>[];
} {
  const { tenantId: tenant_id, caseId: case_id } = aggregate;
  return {
    assessments: aggregate.events.flatMap((event) =>
      event.assessment === undefined
        ? []
        : [
            {
              tenant_id,
              case_id,
              assessment_id: event.assessment.assessmentId,
              version: event.assessment.version,
              event_seq: event.eventSeq,
              event_type: event.eventType,
              scope_version: event.assessment.scopeVersion,
              assessed_at: event.assessment.assessedAt,
              assessed_by: event.assessment.assessedBy,
              assessment: event.assessment,
              complete: event.assessment.complete,
              synthetic: true,
            },
          ],
    ),
    scopes: aggregate.events.flatMap((event) =>
      event.scope === undefined
        ? []
        : [
            {
              tenant_id,
              case_id,
              version: event.scope.version,
              event_seq: event.eventSeq,
              event_type: event.eventType,
              content_hash: event.scope.contentHash,
              query_evidence_ref: event.scope.queryEvidenceRef,
              window_start: event.scope.windowStart,
              window_end: event.scope.windowEnd,
              complete: event.scope.complete,
              limitation_ref: event.scope.limitationRef,
              recorded_at: event.scope.recordedAt,
              synthetic: true,
            },
          ],
    ),
    subjects: aggregate.affectedScopes
      .flatMap((scope) =>
        scope.subjectRefs.map((subject_ref) => ({ scope_version: scope.version, subject_ref })),
      )
      .sort((left, right) =>
        `${left.scope_version}|${left.subject_ref}`.localeCompare(
          `${right.scope_version}|${right.subject_ref}`,
        ),
      ),
    duties: aggregate.duties
      .map((duty) => {
        const event = aggregate.events.findLast(
          (candidate) => candidate.duty?.dutyId === duty.dutyId,
        );
        return {
          tenant_id,
          case_id,
          duty_id: duty.dutyId,
          event_seq: event?.eventSeq,
          event_type: event?.eventType,
          clock_id: duty.clockId,
          jurisdiction: duty.jurisdiction,
          contribution_fact: duty.contributionFact,
          policy_version: duty.policyVersion,
          policy_effective_on: duty.policyEffectiveOn,
          policy_ref: duty.policyRef,
          due_at: duty.dueAt,
          escalation_at: duty.escalationAt,
          required_audiences: duty.requiredAudiences,
          status: duty.status,
          completion_evidence_ref: duty.completionEvidenceRef,
          synthetic: true,
        };
      })
      .sort((left, right) => left.duty_id.localeCompare(right.duty_id)),
    notices: aggregate.events.flatMap((event) =>
      event.notice === undefined
        ? []
        : [
            {
              tenant_id,
              case_id,
              notice_id: event.notice.noticeId,
              event_seq: event.eventSeq,
              event_type: event.eventType,
              duty_id: event.notice.dutyId,
              audience: event.notice.audience,
              payload_ref: event.notice.payloadRef,
              prepared_by: event.notice.preparedBy,
              prepared_at: event.notice.preparedAt,
              approved_by: event.notice.approvedBy,
              approved_at: event.notice.approvedAt,
              effect_intent_key: event.notice.effectIntentKey,
              effect_key: event.notice.effectKey,
              transport_state: event.notice.state,
              terminal_evidence_ref: event.notice.terminalEvidenceRef,
              synthetic: true,
            },
          ],
    ),
    reviews: aggregate.events.flatMap((event) =>
      event.geneticReview === undefined
        ? []
        : [
            {
              tenant_id,
              case_id,
              review_id: event.geneticReview.reviewId,
              event_seq: event.eventSeq,
              event_type: event.eventType,
              grant_ref: event.geneticReview.grantRef,
              audit_ref: event.geneticReview.auditRef,
              work_item_ref: event.geneticReview.workItemRef,
              accessor_ref: event.geneticReview.accessorRef,
              initiator_ref: event.geneticReview.initiatorRef,
              subject_ref: event.geneticReview.subjectRef,
              review_due_at: event.geneticReview.reviewDueAt,
              source_occurred_at: event.geneticReview.sourceOccurredAt,
              risk: event.geneticReview.risk,
              reviewer_ref: event.geneticReview.reviewerRef,
              disposition: event.geneticReview.disposition,
              evidence_ref: event.geneticReview.evidenceRef,
              completed_at: event.geneticReview.completedAt,
              synthetic: true,
            },
          ],
    ),
    fences: aggregate.events
      .map((event) => ({ event_key: event.eventKey, intent_hash: breachEventIntentHash(event) }))
      .sort((left, right) => left.event_key.localeCompare(right.event_key)),
  };
}

async function insertNormalizedFact(exec: BreachQueryable, event: BreachCaseEvent): Promise<void> {
  if (event.assessment !== undefined) {
    await exec.query(
      `INSERT INTO breach_case.factor_assessment
         (tenant_id, case_id, assessment_id, version, event_seq, event_type, scope_version, assessed_at, assessed_by,
          assessment, complete, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,true)
       ON CONFLICT (tenant_id, case_id, version) DO NOTHING`,
      [
        event.tenantId,
        event.caseId,
        event.assessment.assessmentId,
        event.assessment.version,
        event.eventSeq,
        event.eventType,
        event.assessment.scopeVersion,
        event.assessment.assessedAt,
        event.assessment.assessedBy,
        JSON.stringify(event.assessment),
        event.assessment.complete,
      ],
    );
  }
  if (event.scope !== undefined) {
    await exec.query(
      `INSERT INTO breach_case.affected_scope_version
         (tenant_id, case_id, version, event_seq, event_type, content_hash, query_evidence_ref, window_start,
          window_end, complete, limitation_ref, recorded_at, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
       ON CONFLICT (tenant_id, case_id, version) DO NOTHING`,
      [
        event.tenantId,
        event.caseId,
        event.scope.version,
        event.eventSeq,
        event.eventType,
        event.scope.contentHash,
        event.scope.queryEvidenceRef,
        event.scope.windowStart,
        event.scope.windowEnd,
        event.scope.complete,
        event.scope.limitationRef,
        event.scope.recordedAt,
      ],
    );
    for (const subjectRef of event.scope.subjectRefs) {
      await exec.query(
        `INSERT INTO breach_case.affected_subject
           (tenant_id, case_id, scope_version, subject_ref, synthetic)
         VALUES ($1,$2,$3,$4,true)
         ON CONFLICT DO NOTHING`,
        [event.tenantId, event.caseId, event.scope.version, subjectRef],
      );
    }
  }
  if (event.duty !== undefined) {
    await exec.query(
      `INSERT INTO breach_case.jurisdiction_duty
         (tenant_id, case_id, duty_id, event_seq, event_type, clock_id, jurisdiction, contribution_fact,
          policy_version, policy_effective_on, policy_ref, due_at, escalation_at,
          required_audiences, status, completion_evidence_ref, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)
       ON CONFLICT (tenant_id, case_id, duty_id) DO UPDATE
         SET event_seq = EXCLUDED.event_seq,
             event_type = EXCLUDED.event_type,
             status = EXCLUDED.status,
             completion_evidence_ref = EXCLUDED.completion_evidence_ref
       WHERE breach_case.jurisdiction_duty.clock_id = EXCLUDED.clock_id
         AND breach_case.jurisdiction_duty.policy_ref = EXCLUDED.policy_ref
         AND breach_case.jurisdiction_duty.due_at = EXCLUDED.due_at`,
      [
        event.tenantId,
        event.caseId,
        event.duty.dutyId,
        event.eventSeq,
        event.eventType,
        event.duty.clockId,
        event.duty.jurisdiction,
        event.duty.contributionFact,
        event.duty.policyVersion,
        event.duty.policyEffectiveOn,
        event.duty.policyRef,
        event.duty.dueAt,
        event.duty.escalationAt,
        [...event.duty.requiredAudiences],
        event.duty.status,
        event.duty.completionEvidenceRef,
      ],
    );
  }
  if (event.notice !== undefined) {
    await exec.query(
      `INSERT INTO breach_case.notification_evidence
         (tenant_id, case_id, notice_id, event_seq, event_type, duty_id, audience, payload_ref, prepared_by,
          prepared_at, approved_by, approved_at, effect_intent_key, effect_key, transport_state,
          terminal_evidence_ref, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)`,
      [
        event.tenantId,
        event.caseId,
        event.notice.noticeId,
        event.eventSeq,
        event.eventType,
        event.notice.dutyId,
        event.notice.audience,
        event.notice.payloadRef,
        event.notice.preparedBy,
        event.notice.preparedAt,
        event.notice.approvedBy,
        event.notice.approvedAt,
        event.notice.effectIntentKey,
        event.notice.effectKey,
        event.notice.state,
        event.notice.terminalEvidenceRef,
      ],
    );
  }
  if (event.geneticReview !== undefined) {
    await exec.query(
      `INSERT INTO breach_case.genetic_targeted_review
         (tenant_id, case_id, review_id, event_seq, event_type, grant_ref, audit_ref, work_item_ref,
          accessor_ref, initiator_ref, subject_ref, review_due_at, risk,
          source_occurred_at, reviewer_ref, disposition, evidence_ref, completed_at, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'critical',$13,$14,$15,$16,$17,true)`,
      [
        event.tenantId,
        event.caseId,
        event.geneticReview.reviewId,
        event.eventSeq,
        event.eventType,
        event.geneticReview.grantRef,
        event.geneticReview.auditRef,
        event.geneticReview.workItemRef,
        event.geneticReview.accessorRef,
        event.geneticReview.initiatorRef,
        event.geneticReview.subjectRef,
        event.geneticReview.reviewDueAt,
        event.geneticReview.sourceOccurredAt,
        event.geneticReview.reviewerRef,
        event.geneticReview.disposition,
        event.geneticReview.evidenceRef,
        event.geneticReview.completedAt,
      ],
    );
  }
}

async function projectAggregate(
  exec: BreachQueryable,
  aggregate: BreachCaseAggregate,
): Promise<void> {
  const latestAssessment = aggregate.assessments.at(-1);
  const latestScope = aggregate.affectedScopes.at(-1);
  const closed = aggregate.status === 'closed' ? aggregate.events.at(-1) : undefined;
  const updated = await exec.query(
    `UPDATE breach_case.breach_case
        SET status=$3, current_assessment_version=$4, current_scope_version=$5,
            determination=$6::jsonb, strictest_due_at=$7, retention_evidence_ref=$8,
            closure_evidence_ref=$9, last_event_seq=$10
      WHERE tenant_id=$1 AND case_id=$2`,
    [
      aggregate.tenantId,
      aggregate.caseId,
      aggregate.status,
      latestAssessment?.version ?? null,
      latestScope?.version ?? null,
      aggregate.determination === null ? null : JSON.stringify(aggregate.determination),
      aggregate.strictestOpenDueAt,
      aggregate.retentionEvidenceRef,
      closed?.evidenceRef ?? null,
      aggregate.lastEventSeq,
    ],
  );
  if (updated.rowCount !== 1)
    throw new Error('breach projection update failed; caller must roll back');
}

export async function loadBreachCase(
  exec: BreachQueryable,
  tenantId: string,
  caseId: string,
  lock = false,
): Promise<BreachCaseAggregate | null> {
  const projection = await exec.query<{
    readonly case_id: string;
    readonly source_kind: string;
    readonly source_ref: string;
    readonly incident_at: Date | string;
    readonly discovery_at: Date | string;
    readonly owner_ref: string;
    readonly status: string;
    readonly current_assessment_version: number | null;
    readonly current_scope_version: number | null;
    readonly determination: unknown;
    readonly strictest_due_at: Date | string | null;
    readonly retention_evidence_ref: string | null;
    readonly closure_evidence_ref: string | null;
    readonly last_event_seq: number;
  }>(
    `SELECT case_id,source_kind,source_ref,incident_at,discovery_at,owner_ref,status,
            current_assessment_version,current_scope_version,determination,strictest_due_at,
            retention_evidence_ref,closure_evidence_ref,last_event_seq
       FROM breach_case.breach_case
      WHERE tenant_id=$1 AND case_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, caseId],
  );
  if (projection.rows.length === 0) return null;
  const events = await exec.query<{
    readonly tenant_id: string;
    readonly case_id: string;
    readonly event_seq: number;
    readonly event_key: string;
    readonly event_type: string;
    readonly occurred_at: Date | string;
    readonly actor_ref: string;
    readonly payload: BreachCaseEvent;
    readonly payload_hash: string;
  }>(
    `SELECT tenant_id,case_id,event_seq,event_key,event_type,occurred_at,actor_ref,payload,payload_hash
       FROM breach_case.breach_case_event
      WHERE tenant_id=$1 AND case_id=$2 ORDER BY event_seq`,
    [tenantId, caseId],
  );
  for (const row of events.rows) {
    if (
      row.tenant_id !== tenantId ||
      row.case_id !== caseId ||
      row.event_seq !== row.payload.eventSeq ||
      row.event_key !== row.payload.eventKey ||
      row.event_type !== row.payload.eventType ||
      Date.parse(
        row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
      ) !== Date.parse(row.payload.occurredAt) ||
      row.actor_ref !== row.payload.actorRef ||
      row.payload.tenantId !== tenantId ||
      row.payload.caseId !== caseId ||
      row.payload_hash !== breachEventIntentHash(row.payload)
    ) {
      throw new Error('persisted breach event tuple/hash mismatch');
    }
  }
  const aggregate = foldBreachCase(events.rows.map((row) => row.payload));
  const projected = projection.rows[0];
  const asInstant = (value: Date | string | null): string | null =>
    value === null
      ? null
      : value instanceof Date
        ? value.toISOString()
        : new Date(value).toISOString();
  const closedEvidence =
    aggregate.status === 'closed' ? (aggregate.events.at(-1)?.evidenceRef ?? null) : null;
  if (
    projected === undefined ||
    projected.source_kind !== aggregate.sourceKind ||
    projected.source_ref !== aggregate.sourceRef ||
    asInstant(projected.incident_at) !== asInstant(aggregate.incidentAt) ||
    asInstant(projected.discovery_at) !== asInstant(aggregate.discoveryAt) ||
    projected.owner_ref !== aggregate.ownerRef ||
    projected.status !== aggregate.status ||
    projected.current_assessment_version !== (aggregate.assessments.at(-1)?.version ?? null) ||
    projected.current_scope_version !== (aggregate.affectedScopes.at(-1)?.version ?? null) ||
    canonicalJson(projected.determination) !== canonicalJson(aggregate.determination) ||
    asInstant(projected.strictest_due_at) !== asInstant(aggregate.strictestOpenDueAt) ||
    projected.retention_evidence_ref !== aggregate.retentionEvidenceRef ||
    projected.closure_evidence_ref !== closedEvidence ||
    projected.last_event_seq !== aggregate.lastEventSeq
  ) {
    throw new Error('persisted breach projection does not match event fold');
  }
  const [assessmentRows, scopeRows, subjectRows, dutyRows, noticeRows, reviewRows, fenceRows] =
    await Promise.all([
      exec.query<Record<string, unknown>>(
        'SELECT * FROM breach_case.factor_assessment WHERE tenant_id=$1 AND case_id=$2 ORDER BY version',
        [tenantId, caseId],
      ),
      exec.query<Record<string, unknown>>(
        'SELECT * FROM breach_case.affected_scope_version WHERE tenant_id=$1 AND case_id=$2 ORDER BY version',
        [tenantId, caseId],
      ),
      exec.query<{ readonly scope_version: number; readonly subject_ref: string }>(
        'SELECT scope_version,subject_ref FROM breach_case.affected_subject WHERE tenant_id=$1 AND case_id=$2 ORDER BY scope_version,subject_ref',
        [tenantId, caseId],
      ),
      exec.query<Record<string, unknown>>(
        'SELECT * FROM breach_case.jurisdiction_duty WHERE tenant_id=$1 AND case_id=$2 ORDER BY duty_id',
        [tenantId, caseId],
      ),
      exec.query<Record<string, unknown>>(
        'SELECT * FROM breach_case.notification_evidence WHERE tenant_id=$1 AND case_id=$2 ORDER BY event_seq',
        [tenantId, caseId],
      ),
      exec.query<Record<string, unknown>>(
        'SELECT * FROM breach_case.genetic_targeted_review WHERE tenant_id=$1 AND case_id=$2 ORDER BY event_seq',
        [tenantId, caseId],
      ),
      exec.query<{ readonly event_key: string; readonly intent_hash: string }>(
        'SELECT event_key,intent_hash FROM breach_case.effect_fence WHERE tenant_id=$1 AND case_id=$2 ORDER BY event_key',
        [tenantId, caseId],
      ),
    ]);
  const normalizedDutyRows = dutyRows.rows.map((row) => ({
    ...row,
    policy_effective_on: normalizePostgresCalendarDate(row['policy_effective_on']),
  }));
  const normalized = breachNormalizedSnapshot(aggregate);
  if (
    canonicalJson(assessmentRows.rows) !== canonicalJson(normalized.assessments) ||
    canonicalJson(scopeRows.rows) !== canonicalJson(normalized.scopes) ||
    canonicalJson(subjectRows.rows) !== canonicalJson(normalized.subjects) ||
    canonicalJson(normalizedDutyRows) !== canonicalJson(normalized.duties) ||
    canonicalJson(noticeRows.rows) !== canonicalJson(normalized.notices) ||
    canonicalJson(reviewRows.rows) !== canonicalJson(normalized.reviews) ||
    canonicalJson(fenceRows.rows) !== canonicalJson(normalized.fences)
  ) {
    throw new Error('persisted breach normalized facts do not match event fold');
  }
  return aggregate;
}

export async function createBreachCase(
  exec: BreachQueryable,
  aggregate: BreachCaseAggregate,
): Promise<BreachCaseAggregate> {
  if (aggregate.events.length !== 1)
    throw new Error('new breach case must contain only case-opened');
  const validated = foldBreachCase(aggregate.events);
  if (canonicalJson(validated) !== canonicalJson(aggregate)) {
    throw new Error('new breach aggregate does not match its opening event fold');
  }
  const inserted = await exec.query(
    `INSERT INTO breach_case.breach_case
       (tenant_id, case_id, source_kind, source_ref, incident_at, discovery_at,
        owner_ref, status, last_event_seq, synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'assessing',0,true)
     ON CONFLICT DO NOTHING RETURNING case_id`,
    [
      aggregate.tenantId,
      aggregate.caseId,
      aggregate.sourceKind,
      aggregate.sourceRef,
      aggregate.incidentAt,
      aggregate.discoveryAt,
      aggregate.ownerRef,
    ],
  );
  if (inserted.rowCount === 0) {
    const existing = await loadBreachCase(exec, aggregate.tenantId, aggregate.caseId, true);
    if (
      existing === null ||
      breachEventIntentHash(existing.events[0] as BreachCaseEvent) !==
        breachEventIntentHash(aggregate.events[0] as BreachCaseEvent)
    ) {
      throw new Error('breach intake replay key/source reused with changed intent');
    }
    return existing;
  }
  const first = aggregate.events[0];
  if (first === undefined) throw new Error('new breach case is missing case-opened');
  const intentHash = breachEventIntentHash(first);
  await exec.query(
    `INSERT INTO breach_case.effect_fence
       (tenant_id, event_key, case_id, intent_hash, created_at, synthetic)
     VALUES ($1,$2,$3,$4,$5,true)`,
    [aggregate.tenantId, first.eventKey, aggregate.caseId, intentHash, first.occurredAt],
  );
  await exec.query(
    `INSERT INTO breach_case.breach_case_event
       (tenant_id, case_id, event_seq, event_key, event_type, occurred_at,
        actor_ref, payload, payload_hash, synthetic)
     VALUES ($1,$2,1,$3,$4,$5,$6,$7::jsonb,$8,true)`,
    [
      aggregate.tenantId,
      aggregate.caseId,
      first.eventKey,
      first.eventType,
      first.occurredAt,
      first.actorRef,
      JSON.stringify(first),
      intentHash,
    ],
  );
  await projectAggregate(exec, aggregate);
  return aggregate;
}

export async function appendBreachEvents(
  exec: BreachQueryable,
  tenantId: string,
  caseId: string,
  requested: readonly BreachCaseEvent[],
): Promise<BreachCaseAggregate> {
  const current = await loadBreachCase(exec, tenantId, caseId, true);
  if (current === null) throw new Error('breach case not found');
  let events = [...current.events];
  for (const event of requested) {
    if (event.tenantId !== tenantId || event.caseId !== caseId)
      throw new Error('event tuple mismatch');
    const replayed = events.find((prior) => prior.eventKey === event.eventKey);
    if (replayed !== undefined) {
      if (breachEventIntentHash(replayed) !== breachEventIntentHash(event)) {
        throw new Error('breach event idempotency key reused with changed intent');
      }
      continue;
    }
    if (event.eventSeq !== events.length + 1) throw new Error('breach event sequence conflict');
    foldBreachCase([...events, event]);
    const intentHash = breachEventIntentHash(event);
    const fence = await exec.query(
      `INSERT INTO breach_case.effect_fence
         (tenant_id, event_key, case_id, intent_hash, created_at, synthetic)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (tenant_id, event_key) DO NOTHING
       RETURNING intent_hash`,
      [tenantId, event.eventKey, caseId, intentHash, event.occurredAt],
    );
    if (fence.rowCount === 0) {
      const prior = await exec.query<{ readonly case_id: string; readonly intent_hash: string }>(
        `SELECT case_id, intent_hash FROM breach_case.effect_fence
          WHERE tenant_id=$1 AND event_key=$2`,
        [tenantId, event.eventKey],
      );
      const row = prior.rows[0];
      if (row === undefined || row.case_id !== caseId || row.intent_hash !== intentHash) {
        throw new Error('breach event idempotency key reused with changed intent');
      }
      continue;
    }
    await exec.query(
      `INSERT INTO breach_case.breach_case_event
         (tenant_id, case_id, event_seq, event_key, event_type, occurred_at,
          actor_ref, payload, payload_hash, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,true)`,
      [
        tenantId,
        caseId,
        event.eventSeq,
        event.eventKey,
        event.eventType,
        event.occurredAt,
        event.actorRef,
        JSON.stringify(event),
        intentHash,
      ],
    );
    await insertNormalizedFact(exec, event);
    events = [...events, event];
  }
  const aggregate = foldBreachCase(events);
  await projectAggregate(exec, aggregate);
  return aggregate;
}
