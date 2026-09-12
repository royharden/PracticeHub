import { describe, expect, it } from 'vitest';

import {
  closeBreachCase,
  foldBreachCase,
  openBreachCase,
  recordAffectedScope,
  recordDetermination,
  recordFourFactorAssessment,
  recordNotice,
  linkJurisdictionDuty,
  strictestOpenDue,
  type JurisdictionDuty,
} from './breach-case.js';
import { syntheticBreachCaseSeedV1 } from './seed-data.js';

function opened() {
  return openBreachCase({
    tenantId: 'northwind-synthetic',
    caseId: 'breach-unit-1',
    sourceKind: 'audit-anomaly',
    sourceRef: 'incident:unit-1',
    incidentAt: '2026-03-01T10:00:00Z',
    discoveryAt: '2026-03-02T10:00:00Z',
    ownerRef: 'compliance:officer',
    actorRef: 'system:detector',
    eventKey: 'unit-open-1',
  });
}

function assessed(extent: 'limited' | 'unknown' = 'limited') {
  const scoped = recordAffectedScope(opened(), {
    subjectRefs: ['person:unit-subject'],
    queryEvidenceRef: 'audit-query:unit-initial',
    windowStart: '2026-03-01T00:00:00Z',
    windowEnd: '2026-03-02T10:00:00Z',
    complete: true,
    limitationRef: null,
    recordedAt: '2026-03-02T10:30:00Z',
    actorRef: 'compliance:officer',
    eventKey: 'unit-scope-initial',
  });
  return recordFourFactorAssessment(scoped, {
    assessmentId: 'assessment-unit-1',
    assessedAt: '2026-03-02T11:00:00Z',
    assessedBy: 'compliance:officer',
    actorRef: 'compliance:officer',
    eventKey: 'unit-assessment-1',
    nature: { phiCategoryRefs: ['phi:genetic'], extent, evidenceRefs: ['evidence:nature'] },
    recipient: {
      recipientClass: 'vendor',
      relationshipRef: 'vendor:labs',
      evidenceRefs: ['evidence:recipient'],
    },
    acquisition: { state: 'viewed', evidenceRefs: ['evidence:acquired'] },
    mitigation: {
      state: 'partial',
      actionRefs: ['action:disabled'],
      evidenceRefs: ['evidence:mitigation'],
    },
  });
}

describe('breach aggregate fail-closed behavior', () => {
  it('rejects a raw determination event that bypasses assessment and approval invariants', () => {
    const aggregate = opened();
    expect(() =>
      foldBreachCase([
        ...aggregate.events,
        {
          tenantId: aggregate.tenantId,
          caseId: aggregate.caseId,
          eventSeq: 2,
          eventKey: 'raw-determination',
          eventType: 'determination-recorded',
          occurredAt: '2026-03-02T11:00:00Z',
          actorRef: 'person:same',
          determination: {
            kind: 'low-probability',
            assessmentVersion: 999,
            rationaleRef: 'rationale:raw',
            determinedBy: 'person:same',
            approvedBy: 'person:same',
            determinedAt: '2026-03-02T11:00:00Z',
            synthetic: true,
          },
          synthetic: true,
        },
      ]),
    ).toThrow(/current complete known scope assessment/);
  });

  it('rejects a runtime factor value outside the closed vocabulary', () => {
    expect(() =>
      recordFourFactorAssessment(
        recordAffectedScope(opened(), {
          subjectRefs: [],
          queryEvidenceRef: 'audit-query:vocabulary',
          windowStart: '2026-03-01T00:00:00Z',
          windowEnd: '2026-03-02T10:00:00Z',
          complete: true,
          limitationRef: null,
          recordedAt: '2026-03-02T10:30:00Z',
          actorRef: 'compliance:officer',
          eventKey: 'vocabulary-scope',
        }),
        {
          assessmentId: 'vocabulary-assessment',
          assessedAt: '2026-03-02T11:00:00Z',
          assessedBy: 'compliance:officer',
          actorRef: 'compliance:officer',
          eventKey: 'vocabulary-assess',
          nature: {
            phiCategoryRefs: ['phi:genetic'],
            extent: 'unrecognized' as 'limited',
            evidenceRefs: ['evidence:nature'],
          },
          recipient: {
            recipientClass: 'vendor',
            relationshipRef: null,
            evidenceRefs: ['evidence:recipient'],
          },
          acquisition: { state: 'viewed', evidenceRefs: ['evidence:viewed'] },
          mitigation: { state: 'partial', actionRefs: [], evidenceRefs: ['evidence:mitigation'] },
        },
      ),
    ).toThrow(/invalid nature extent/);
  });
  it('keeps incident and discovery distinct and rejects inverted discovery', () => {
    expect(opened()).toMatchObject({
      incidentAt: '2026-03-01T10:00:00Z',
      discoveryAt: '2026-03-02T10:00:00Z',
    });
    expect(() =>
      openBreachCase({
        ...opened(),
        caseId: 'breach-unit-inverted',
        discoveryAt: '2026-02-28T10:00:00Z',
        actorRef: 'system:detector',
        eventKey: 'unit-open-inverted',
      }),
    ).toThrow(/cannot precede/);
  });

  it('blocks a determination when any four-factor value is unknown', () => {
    expect(() =>
      recordDetermination(assessed('unknown'), {
        kind: 'low-probability',
        rationaleRef: 'rationale:unit',
        determinedBy: 'compliance:officer',
        approvedBy: 'owner:cfo',
        determinedAt: '2026-03-02T12:00:00Z',
        eventKey: 'unit-determination',
      }),
    ).toThrow(/no unknown factor/);
  });

  it('versions content-addressed scope and reopens a determined case', () => {
    const determined = recordDetermination(assessed(), {
      kind: 'low-probability',
      rationaleRef: 'rationale:unit',
      determinedBy: 'compliance:officer',
      approvedBy: 'owner:cfo',
      determinedAt: '2026-03-02T12:00:00Z',
      eventKey: 'unit-determination',
    });
    const changed = recordAffectedScope(determined, {
      subjectRefs: ['person:b', 'person:a', 'person:a'],
      queryEvidenceRef: 'audit-query:unit',
      windowStart: '2026-03-01T00:00:00Z',
      windowEnd: '2026-03-02T10:00:00Z',
      complete: false,
      limitationRef: 'limitation:partial-index',
      recordedAt: '2026-03-02T13:00:00Z',
      actorRef: 'compliance:officer',
      eventKey: 'unit-scope',
    });
    expect(changed.status).toBe('assessing');
    expect(changed.determination).toBeNull();
    expect(changed.affectedScopes[1]?.subjectRefs).toEqual(['person:a', 'person:b']);
    expect(changed.affectedScopes[1]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      recordDetermination(changed, {
        kind: 'low-probability',
        rationaleRef: 'rationale:stale',
        determinedBy: 'compliance:officer',
        approvedBy: 'owner:cfo',
        determinedAt: '2026-03-02T14:00:00Z',
        eventKey: 'unit-stale-determination',
      }),
    ).toThrow(/complete four-factor assessment/);
  });

  it('selects the earliest provider-returned open due instant regardless of input order', () => {
    const duties: JurisdictionDuty[] = ['2026-05-01T00:00:00Z', '2026-04-01T00:00:00Z'].map(
      (dueAt, index) => ({
        dutyId: `duty-${index}`,
        clockId: `clock:${index}`,
        jurisdiction: index === 0 ? 'floor' : 'NY',
        contributionFact: index === 0 ? 'floor' : 'patient',
        policyVersion: 1,
        policyEffectiveOn: '2026-01-01',
        policyRef: `policy:${index}`,
        dueAt,
        escalationAt: '2026-03-20T00:00:00Z',
        requiredAudiences: ['individual'],
        status: 'open',
        completionEvidenceRef: null,
        synthetic: true,
      }),
    );
    expect(strictestOpenDue(duties)).toBe('2026-04-01T00:00:00Z');
    expect(strictestOpenDue([...duties].reverse())).toBe('2026-04-01T00:00:00Z');
  });

  it('never treats accepted transport as delivered evidence', () => {
    const closed = syntheticBreachCaseSeedV1.aggregates[0];
    const deliveredEvent = closed.events.find((event) => event.notice?.state === 'delivered');
    expect(deliveredEvent?.notice).toBeDefined();
    const mutated = closed.events.map((event) =>
      event === deliveredEvent && event.notice !== undefined
        ? {
            ...event,
            notice: { ...event.notice, state: 'failed' as const, terminalEvidenceRef: null },
          }
        : event,
    );
    const aggregate = foldBreachCase(mutated.slice(0, -1));
    expect(() =>
      closeBreachCase(aggregate, {
        actorRef: 'compliance:privacy-officer',
        occurredAt: '2026-03-03T14:00:00Z',
        evidenceRef: 'evidence:unit-close',
        eventKey: 'unit-close',
      }),
    ).toThrow(/terminal notice evidence/);
  });

  it('rejects a notice transition that mutates immutable intent', () => {
    const preparedIndex = syntheticBreachCaseSeedV1.aggregates[0].events.findIndex(
      (event) => event.notice?.state === 'prepared',
    );
    const seeded = foldBreachCase(
      syntheticBreachCaseSeedV1.aggregates[0].events.slice(0, preparedIndex + 1),
    );
    const notice = seeded.notices[0];
    if (notice === undefined) throw new Error('seeded notice missing');
    expect(() =>
      recordNotice(
        seeded,
        {
          ...notice,
          payloadRef: 'payload:changed',
          approvedBy: 'owner:cfo',
          approvedAt: '2026-03-03T10:00:00Z',
          state: 'approved',
        },
        'owner:cfo',
        'unit-notice-mutate',
        '2026-03-03T10:00:00Z',
      ),
    ).toThrow(/immutable intent/);
  });

  it('rejects a delivered notice as the first lifecycle event', () => {
    const beforeNotice = foldBreachCase(syntheticBreachCaseSeedV1.aggregates[0].events.slice(0, 5));
    expect(() =>
      recordNotice(
        beforeNotice,
        {
          noticeId: 'raw-delivered',
          dutyId: 'synthetic-floor-duty',
          audience: 'individual',
          payloadRef: 'payload:raw',
          preparedBy: 'person:same',
          preparedAt: '2026-03-03T10:00:00Z',
          approvedBy: 'person:same',
          approvedAt: '2026-03-03T09:00:00Z',
          effectIntentKey: null,
          effectKey: null,
          state: 'delivered',
          terminalEvidenceRef: 'receipt:raw',
          synthetic: true,
        },
        'person:same',
        'raw-delivered-event',
        '2026-03-03T10:00:00Z',
      ),
    ).toThrow(/approval|lifecycle|effect/);
  });

  it('requires delivered evidence for every provider-supplied audience', () => {
    const complete = syntheticBreachCaseSeedV1.aggregates[0];
    const withoutClosure = complete.events.slice(0, -1).map((event) =>
      event.duty === undefined
        ? event
        : {
            ...event,
            duty: { ...event.duty, requiredAudiences: ['individual', 'media'] as const },
          },
    );
    const aggregate = foldBreachCase(withoutClosure);
    expect(() =>
      closeBreachCase(aggregate, {
        actorRef: 'compliance:officer',
        occurredAt: '2026-03-03T14:00:00Z',
        evidenceRef: 'evidence:close',
        eventKey: 'close-missing-media',
      }),
    ).toThrow(/required audience/);
  });

  it('does not allow a closed case to gain a new open duty', () => {
    const closed = syntheticBreachCaseSeedV1.aggregates[0];
    expect(() =>
      linkJurisdictionDuty(
        closed,
        {
          dutyId: 'late-duty',
          clockId: 'clock:late',
          jurisdiction: 'NY',
          contributionFact: 'patient',
          policyVersion: 1,
          policyEffectiveOn: '2026-01-01',
          policyRef: 'policy:late',
          dueAt: '2026-05-10T00:00:00Z',
          escalationAt: '2026-05-01T00:00:00Z',
          requiredAudiences: ['individual'],
          status: 'open',
          completionEvidenceRef: null,
          synthetic: true,
        },
        'system:clock',
        'late-duty-linked',
        '2026-03-04T00:00:00Z',
      ),
    ).toThrow(/closed breach case/);
  });

  it('raw scope-version replay invalidates stale determination without relying on case-reopened', () => {
    const closed = syntheticBreachCaseSeedV1.aggregates[0];
    const beforeClose = foldBreachCase(closed.events.slice(0, -1));
    const helperResult = recordAffectedScope(beforeClose, {
      subjectRefs: ['person:synthetic-patient-1', 'person:newly-affected'],
      queryEvidenceRef: 'audit-query:raw-widened',
      windowStart: '2026-03-01T08:00:00Z',
      windowEnd: '2026-03-03T10:00:00Z',
      complete: true,
      limitationRef: null,
      recordedAt: '2026-03-03T12:30:00Z',
      actorRef: 'compliance:officer',
      eventKey: 'raw-widened-scope',
    });
    const scopeOnly = helperResult.events[beforeClose.events.length];
    if (scopeOnly === undefined) throw new Error('scope event missing');
    const replayed = foldBreachCase([...beforeClose.events, scopeOnly]);
    expect(replayed.determination).toBeNull();
    expect(replayed.status).toBe('assessing');
    expect(() =>
      closeBreachCase(replayed, {
        actorRef: 'compliance:officer',
        occurredAt: '2026-03-03T14:00:00Z',
        evidenceRef: 'evidence:invalid-close',
        eventKey: 'invalid-close-after-scope',
      }),
    ).toThrow(/determination/);
  });
});
