import { expect } from 'vitest';

import {
  completeGeneticTargetedReview,
  openBreachCase,
  openGeneticTargetedReview,
  recordAffectedScope,
  recordDetermination,
  recordFourFactorAssessment,
  type BreachCaseAggregate,
  type GeneticElevationSourceRecord,
} from './breach-case.js';

export const breachFixtureOps = [
  'known-four-factor',
  'unknown-factor-blocks',
  'discovery-distinct',
  'scope-version-reopens',
  'genetic-targeted-review',
  'standard-genetic-refused',
  'independent-reviewer-required',
  'duplicate-genetic-idempotent',
] as const;
export type BreachFixtureOp = (typeof breachFixtureOps)[number];

export interface BreachFixtureCase {
  readonly name: string;
  readonly op: BreachFixtureOp;
}

export interface BreachFixtureFile {
  readonly synthetic: true;
  readonly requirementId: 'R6-REQ-006' | 'R6-SR-033';
  readonly class: 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';
  readonly description: string;
  readonly cases: readonly BreachFixtureCase[];
}

function opened(): BreachCaseAggregate {
  return openBreachCase({
    tenantId: 'northwind-synthetic',
    caseId: 'breach-fixture-1',
    sourceKind: 'audit-anomaly',
    sourceRef: 'incident:fixture-1',
    incidentAt: '2026-03-01T10:00:00Z',
    discoveryAt: '2026-03-02T10:00:00Z',
    ownerRef: 'compliance:officer-1',
    actorRef: 'system:detector',
    eventKey: 'breach-open-fixture-1',
  });
}

function assessed(unknown = false): BreachCaseAggregate {
  const scoped = recordAffectedScope(opened(), {
    subjectRefs: ['person:fixture-subject'],
    queryEvidenceRef: 'audit-query:fixture-initial',
    windowStart: '2026-03-01T00:00:00Z',
    windowEnd: '2026-03-02T10:00:00Z',
    complete: true,
    limitationRef: null,
    recordedAt: '2026-03-02T10:30:00Z',
    actorRef: 'compliance:officer-1',
    eventKey: 'breach-scope-fixture-1',
  });
  return recordFourFactorAssessment(scoped, {
    assessmentId: 'assessment-fixture-1',
    assessedAt: '2026-03-02T11:00:00Z',
    assessedBy: 'compliance:officer-1',
    actorRef: 'compliance:officer-1',
    eventKey: 'breach-assess-fixture-1',
    nature: {
      phiCategoryRefs: ['phi-category:genetic'],
      extent: unknown ? 'unknown' : 'limited',
      evidenceRefs: ['evidence:nature-1'],
    },
    recipient: {
      recipientClass: 'vendor',
      relationshipRef: 'vendor:synthetic-1',
      evidenceRefs: ['evidence:recipient-1'],
    },
    acquisition: { state: 'viewed', evidenceRefs: ['evidence:viewed-1'] },
    mitigation: {
      state: 'complete',
      actionRefs: ['action:revoked-link'],
      evidenceRefs: ['evidence:mitigation-1'],
    },
  });
}

function geneticSource(
  severity: 'standard' | 'elevated-genetic' = 'elevated-genetic',
): GeneticElevationSourceRecord {
  return {
    tenantId: 'northwind-synthetic',
    sourceEventKey: 'genetic-elevation-fixture-1',
    grantRef: 'break-glass-grant:bg-1',
    auditRef: 'audit-record:bg-1',
    workItemRef: 'work-item:bg-review-1',
    accessorRef: 'person:accessor-1',
    initiatorRef: 'person:initiator-1',
    subjectRef: 'person:subject-1',
    severity,
    partitionTags: severity === 'elevated-genetic' ? ['gipa-genetic'] : [],
    reviewDueAt: '2026-03-03T10:00:00Z',
    occurredAt: '2026-03-02T10:00:00Z',
    synthetic: true,
  };
}

export function executeBreachFixtureCase(fixtureCase: BreachFixtureCase): void {
  switch (fixtureCase.op) {
    case 'known-four-factor': {
      const result = recordDetermination(assessed(), {
        kind: 'reportable',
        rationaleRef: 'rationale:fixture-1',
        determinedBy: 'compliance:officer-1',
        approvedBy: 'owner:cfo-1',
        determinedAt: '2026-03-02T12:00:00Z',
        eventKey: 'breach-determine-fixture-1',
      });
      expect(result.status).toBe('determined-reportable');
      return;
    }
    case 'unknown-factor-blocks':
      expect(() =>
        recordDetermination(assessed(true), {
          kind: 'low-probability',
          rationaleRef: 'rationale:fixture-1',
          determinedBy: 'compliance:officer-1',
          approvedBy: 'owner:cfo-1',
          determinedAt: '2026-03-02T12:00:00Z',
          eventKey: 'breach-determine-fixture-1',
        }),
      ).toThrow(/no unknown factor/);
      return;
    case 'discovery-distinct': {
      const result = opened();
      expect(result.discoveryAt).toBe('2026-03-02T10:00:00Z');
      expect(result.incidentAt).toBe('2026-03-01T10:00:00Z');
      return;
    }
    case 'scope-version-reopens': {
      const determined = recordDetermination(assessed(), {
        kind: 'low-probability',
        rationaleRef: 'rationale:fixture-1',
        determinedBy: 'compliance:officer-1',
        approvedBy: 'owner:cfo-1',
        determinedAt: '2026-03-02T12:00:00Z',
        eventKey: 'breach-determine-fixture-1',
      });
      const widened = recordAffectedScope(determined, {
        subjectRefs: ['person:a', 'person:b'],
        queryEvidenceRef: 'audit-query:scope-2',
        windowStart: '2026-03-01T00:00:00Z',
        windowEnd: '2026-03-02T10:00:00Z',
        complete: false,
        limitationRef: 'limitation:audit-gap-1',
        recordedAt: '2026-03-02T13:00:00Z',
        actorRef: 'compliance:officer-1',
        eventKey: 'breach-scope-fixture-2',
      });
      expect(widened.status).toBe('assessing');
      expect(widened.affectedScopes).toHaveLength(2);
      expect(widened.assessments).toHaveLength(1);
      expect(() =>
        recordDetermination(widened, {
          kind: 'low-probability',
          rationaleRef: 'rationale:stale-fixture',
          determinedBy: 'compliance:officer-1',
          approvedBy: 'owner:cfo-1',
          determinedAt: '2026-03-02T14:00:00Z',
          eventKey: 'breach-stale-determination',
        }),
      ).toThrow(/complete four-factor assessment/);
      return;
    }
    case 'genetic-targeted-review': {
      const result = openGeneticTargetedReview(opened(), geneticSource(), 'system:consumer');
      expect(result.geneticReviews[0]).toMatchObject({
        risk: 'critical',
        reviewDueAt: '2026-03-03T10:00:00Z',
      });
      return;
    }
    case 'standard-genetic-refused':
      expect(() =>
        openGeneticTargetedReview(opened(), geneticSource('standard'), 'system:consumer'),
      ).toThrow(/elevated-genetic/);
      return;
    case 'independent-reviewer-required': {
      const aggregate = openGeneticTargetedReview(opened(), geneticSource(), 'system:consumer');
      expect(() =>
        completeGeneticTargetedReview(aggregate, {
          reviewId: 'genetic-review-genetic-elevation-fixture-1',
          reviewerRef: 'person:accessor-1',
          disposition: 'appropriate',
          evidenceRef: 'evidence:review-1',
          completedAt: '2026-03-03T09:00:00Z',
          eventKey: 'genetic-review-complete-1',
        }),
      ).toThrow(/independent reviewer/);
      return;
    }
    case 'duplicate-genetic-idempotent': {
      const once = openGeneticTargetedReview(opened(), geneticSource(), 'system:consumer');
      const twice = openGeneticTargetedReview(once, geneticSource(), 'system:consumer');
      expect(twice.events).toHaveLength(once.events.length);
      expect(() =>
        openGeneticTargetedReview(
          once,
          { ...geneticSource(), reviewDueAt: '2026-03-04T10:00:00Z' },
          'system:consumer',
        ),
      ).toThrow(/changed correlation/);
      return;
    }
    default: {
      const exhaustive: never = fixtureCase.op;
      throw new Error(`unsupported fixture op ${String(exhaustive)}`);
    }
  }
}
