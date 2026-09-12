import { InMemoryBlobStore } from './blob.js';
import {
  assertExactPageCover,
  confirmFaxRouting,
  evaluateFaxSenderPattern,
  routeInboundFax,
  sweepUrgentFaxReviews,
  type FaxInspection,
  type FaxPatientMatchResult,
  type FaxUrgentWorkDescriptor,
} from './fax-routing.js';
import type { InboundFaxDelivery } from './intake-port.js';

export const acceptedFaxFixtureOps = [
  'route',
  'page-cover',
  'confirm',
  'urgent-sweep',
  'sender-pattern',
] as const;
export type FaxFixtureOp = (typeof acceptedFaxFixtureOps)[number];

export interface FaxFixtureCase {
  readonly name: string;
  readonly op: FaxFixtureOp;
  readonly scenario?: 'single' | 'multi' | 'ambiguous' | 'sub-threshold' | 'unreadable';
  readonly urgency?: 'negative' | 'positive' | 'uncertain';
  readonly pageCount?: number;
  readonly pageGroups?: readonly (readonly number[])[];
  readonly expectedKinds?: readonly string[];
  readonly expectedReasons?: readonly string[];
  readonly expectedUrgent?: boolean;
  readonly expectedError?: string;
  readonly expectedFilings?: number;
  readonly dueAt?: string;
  readonly asOf?: string;
  readonly expectedSweep?: readonly string[];
  readonly senderOutcomes?: readonly ('matched' | 'unmatched' | 'unidentifiable')[];
  readonly outreachThreshold?: number;
  readonly expectedOutreach?: boolean;
}

const tenantId = 'northwind-synthetic';

function delivery(pageCount: number): InboundFaxDelivery {
  return {
    tenantId,
    faxId: 'synthetic-fax-fixture',
    senderRef: 'synthetic-sender:fixture',
    pageCount,
    bytes: 'synthetic-fax-content:fixture',
    mediaType: 'application/pdf',
    receivedAt: '2026-03-10T08:00:00Z',
    synthetic: true,
  };
}

function inspection(fixtureCase: FaxFixtureCase, pageCount: number): FaxInspection {
  const scenario = fixtureCase.scenario ?? 'single';
  const rawGroups =
    fixtureCase.pageGroups ??
    (scenario === 'multi'
      ? [[1], Array.from({ length: pageCount - 1 }, (_, index) => index + 2)]
      : [Array.from({ length: pageCount }, (_, index) => index + 1)]);
  return {
    tenantId,
    faxId: 'synthetic-fax-fixture',
    documentId: 'nd-fax-fixture',
    providerRef: 'synthetic-idp:fixture',
    providerVersion: 'synthetic-idp-v1',
    readable: scenario !== 'unreadable',
    groups: rawGroups.map((pages, index) => ({
      groupId: `group-${String(index + 1)}`,
      pages,
      documentType: index === 0 ? 'referral' : 'outside-records',
      confidence: scenario === 'sub-threshold' ? 0.5 : 1,
      identityEvidence: {
        facts: { 'given-name': `synthetic-${String(index + 1)}` },
        observedAttributeNames: ['patient-name'],
        evidenceRef: `synthetic-idp:evidence-${String(index + 1)}`,
      },
    })),
    urgency: {
      signal: fixtureCase.urgency ?? 'negative',
      evidenceRef: `synthetic-urgency:${fixtureCase.urgency ?? 'negative'}`,
    },
    realParityCase: `fax-parity:${scenario}`,
    synthetic: true,
  };
}

async function routed(fixtureCase: FaxFixtureCase) {
  const pageCount = fixtureCase.pageCount ?? 2;
  const scenario = fixtureCase.scenario ?? 'single';
  return routeInboundFax(
    new InMemoryBlobStore(),
    [],
    {
      tenantId,
      documentId: 'nd-fax-fixture',
      documentEventId: 'nde-fax-fixture',
      actorRef: 'synthetic-fax-gateway',
      delivery: delivery(pageCount),
      minimumConfidence: 0.9,
      urgentDueAt: fixtureCase.dueAt ?? '2026-03-10T08:15:00Z',
      afterHoursRouteRef: 'synthetic-oncall:fax',
    },
    {
      intelligence: {
        async inspect() {
          return inspection(fixtureCase, pageCount);
        },
      },
      matcher: {
        async resolve(input): Promise<FaxPatientMatchResult> {
          if (scenario === 'ambiguous') {
            return {
              kind: 'ambiguous',
              tenantId: input.tenantId,
              candidates: [
                { personRef: 'synthetic-person:a', matchedAttributeNames: ['patient-name'] },
                { personRef: 'synthetic-person:b', matchedAttributeNames: ['patient-name'] },
              ],
            };
          }
          return {
            kind: 'single',
            tenantId: input.tenantId,
            personRef: `synthetic-person:${input.groupId}`,
            matchedAttributeNames: ['patient-name'],
          };
        },
      },
      workItems: {
        async openUrgent(input) {
          return {
            workItemRef: `synthetic-workitem:${input.documentId}`,
            outcome: 'opened',
            resendsExternalEffect: false,
          };
        },
      },
    },
  );
}

function urgent(
  documentId: string,
  signal: 'positive' | 'uncertain',
  dueAt: string,
): FaxUrgentWorkDescriptor {
  return {
    tenantId,
    subjectRef: `fax:${tenantId}:${documentId}`,
    faxId: `fax-${documentId}`,
    documentId,
    signal,
    receivedAt: '2026-03-10T08:00:00Z',
    dueAt,
    afterHoursRouteRef: 'synthetic-oncall:fax',
    evidenceRef: `synthetic-urgency:${documentId}`,
    idempotencyKey: `urgent-fax:${tenantId}:${documentId}`,
    purpose: 'urgent-fax-review',
    synthetic: true,
  };
}

export async function runFaxFixtureCase(fixtureCase: FaxFixtureCase): Promise<unknown> {
  switch (fixtureCase.op) {
    case 'route':
      return routed(fixtureCase);
    case 'page-cover': {
      const candidate = inspection(fixtureCase, fixtureCase.pageCount ?? 2);
      assertExactPageCover(candidate.groups, fixtureCase.pageCount ?? 2);
      return { ok: true };
    }
    case 'confirm': {
      const result = await routed(fixtureCase);
      return confirmFaxRouting(result, {
        tenantId,
        confirmedBy: 'synthetic-staff:coordinator',
        confirmedAt: '2026-03-10T08:10:00Z',
        evidenceRef: 'synthetic-confirmation:fixture',
        dispositions: result.groups.map((group) =>
          group.kind === 'awaiting-human-confirmation'
            ? {
                kind: 'confirm' as const,
                groupId: group.groupId,
                personRef: group.proposedPersonRef,
                pages: group.pages,
                documentType: group.documentType,
              }
            : {
                kind: 'quarantine' as const,
                groupId: group.groupId,
                pages: group.pages,
                reasonRef: `synthetic-reason:${group.reason}`,
              },
        ),
      });
    }
    case 'urgent-sweep': {
      const dueAt = fixtureCase.dueAt ?? '2026-03-10T08:15:00Z';
      return sweepUrgentFaxReviews(
        [
          urgent('nd-positive', 'positive', dueAt),
          urgent('nd-uncertain', 'uncertain', '2026-03-10T08:10:00Z'),
        ],
        fixtureCase.asOf ?? dueAt,
      );
    }
    case 'sender-pattern':
      return evaluateFaxSenderPattern({
        tenantId,
        senderRef: 'synthetic-sender:fixture',
        outcomes: (fixtureCase.senderOutcomes ?? ['matched']).map((outcome) => ({ outcome })),
        outreachThreshold: fixtureCase.outreachThreshold ?? 2,
        perSenderNoteRef: 'synthetic-note:fixture',
        perFaxMinimumConfidence: 0.9,
      });
    default:
      throw new Error(
        `unrecognized fax fixture op ${JSON.stringify((fixtureCase as { op: string }).op)}`,
      );
  }
}
