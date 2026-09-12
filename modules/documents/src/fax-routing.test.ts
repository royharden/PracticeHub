import { describe, expect, it, vi } from 'vitest';

import { InMemoryBlobStore } from './blob.js';
import {
  assertExactPageCover,
  confirmFaxRouting,
  evaluateFaxSenderPattern,
  routeInboundFax,
  sweepUrgentFaxReviews,
  type FaxInspection,
  type FaxRoutingPorts,
  type RouteInboundFaxInput,
  type FaxUrgentWorkDescriptor,
} from './fax-routing.js';
import type { InboundFaxDelivery } from './intake-port.js';

const tenantId = 'northwind-synthetic';

function delivery(overrides: Partial<InboundFaxDelivery> = {}): InboundFaxDelivery {
  return {
    tenantId,
    faxId: 'synthetic-fax-9001',
    senderRef: 'synthetic-sender:clinic-a',
    pageCount: 2,
    bytes: 'synthetic-fax-content:routing-test',
    mediaType: 'application/pdf',
    receivedAt: '2026-03-10T08:00:00Z',
    synthetic: true,
    ...overrides,
  };
}

function inspection(overrides: Partial<FaxInspection> = {}): FaxInspection {
  return {
    tenantId,
    faxId: 'synthetic-fax-9001',
    documentId: 'nd-fax-9001',
    providerRef: 'synthetic-idp:provider',
    providerVersion: 'synthetic-idp-v1',
    readable: true,
    groups: [
      {
        groupId: 'group-a',
        pages: [1, 2],
        documentType: 'referral',
        confidence: 1,
        identityEvidence: {
          facts: { 'given-name': 'synthetic-a', 'birth-date': '1980-01-01' },
          observedAttributeNames: ['patient-name', 'date-of-birth'],
          evidenceRef: 'synthetic-idp:evidence-a',
        },
      },
    ],
    urgency: { signal: 'negative', evidenceRef: 'synthetic-urgency:negative' },
    realParityCase: 'fax-parity:single',
    synthetic: true,
    ...overrides,
  };
}

function primaryGroup() {
  const group = inspection().groups[0];
  if (group === undefined) {
    throw new Error('routing test fixture must include its primary group');
  }
  return group;
}

function ports(value: FaxInspection, trace: string[] = []): FaxRoutingPorts {
  let urgentWorkItemRef: string | undefined;
  return {
    intelligence: {
      async inspect() {
        trace.push('urgent-screen');
        return value;
      },
    },
    matcher: {
      async resolve(input) {
        trace.push('identity-resolution');
        return {
          kind: 'single',
          tenantId: input.tenantId,
          personRef: 'synthetic-person:a',
          matchedAttributeNames: ['patient-name', 'date-of-birth'],
        };
      },
    },
    workItems: {
      async openUrgent(input) {
        if (urgentWorkItemRef !== undefined) {
          return {
            workItemRef: urgentWorkItemRef,
            outcome: 'deduplicated',
            resendsExternalEffect: false,
          };
        }
        trace.push('urgent-work-item');
        urgentWorkItemRef = `synthetic-workitem:${input.documentId}`;
        return {
          workItemRef: urgentWorkItemRef,
          outcome: 'opened',
          resendsExternalEffect: false,
        };
      },
    },
  };
}

function routeInput(overrides: Partial<RouteInboundFaxInput> = {}): RouteInboundFaxInput {
  return {
    tenantId,
    documentId: 'nd-fax-9001',
    documentEventId: 'nde-fax-9001',
    actorRef: 'synthetic-fax-gateway',
    delivery: delivery(),
    minimumConfidence: 0.9,
    urgentDueAt: '2026-03-10T08:15:00Z',
    afterHoursRouteRef: 'synthetic-oncall:fax',
    ...overrides,
  };
}

describe('fax routing invariants', () => {
  it('screens urgency and opens urgent work before identity resolution', async () => {
    const trace: string[] = [];
    const result = await routeInboundFax(
      new InMemoryBlobStore(),
      [],
      routeInput(),
      ports(
        inspection({
          urgency: { signal: 'positive', evidenceRef: 'synthetic-urgency:positive' },
        }),
        trace,
      ),
    );
    expect(trace).toEqual(['urgent-screen', 'urgent-work-item', 'identity-resolution']);
    expect(result.urgentWork?.signal).toBe('positive');
  });

  it('confidence 1.0 still yields only a proposal awaiting human confirmation', async () => {
    const result = await routeInboundFax(
      new InMemoryBlobStore(),
      [],
      routeInput(),
      ports(inspection()),
    );
    expect(result.requiresHumanConfirmation).toBe(true);
    expect(result.groups[0]?.kind).toBe('awaiting-human-confirmation');
    expect(result.log.map((event) => event.eventType)).toEqual(['received']);
  });

  it('an unreadable urgent fax opens urgent work and never invokes identity matching', async () => {
    const matcher = vi.fn();
    const value = inspection({
      readable: false,
      urgency: { signal: 'uncertain', evidenceRef: 'synthetic-urgency:uncertain' },
    });
    const configured: FaxRoutingPorts = {
      ...ports(value),
      matcher: { resolve: matcher },
    };
    const result = await routeInboundFax(new InMemoryBlobStore(), [], routeInput(), configured);
    expect(matcher).not.toHaveBeenCalled();
    expect(result.groups[0]).toMatchObject({ kind: 'manual-review', reason: 'unreadable' });
    expect(result.urgentWork).not.toBeNull();
  });

  it('a below-threshold match is blocked even when the matcher finds one person', async () => {
    const result = await routeInboundFax(
      new InMemoryBlobStore(),
      [],
      routeInput(),
      ports(
        inspection({
          groups: [{ ...primaryGroup(), confidence: 0.89 }],
        }),
      ),
    );
    expect(result.groups[0]).toMatchObject({ kind: 'manual-review', reason: 'sub-threshold' });
  });

  it('rejects duplicate and missing page assignments by exact page number', () => {
    const base = primaryGroup();
    expect(() =>
      assertExactPageCover(
        [
          { ...base, groupId: 'group-a', pages: [1] },
          { ...base, groupId: 'group-b', pages: [1, 2] },
        ],
        2,
      ),
    ).toThrow('page 1 is assigned twice');
    expect(() => assertExactPageCover([{ ...base, pages: [1] }], 2)).toThrow('page 2 is missing');
    expect(() =>
      assertExactPageCover(
        [
          { ...base, pages: [1] },
          { ...base, pages: [2] },
        ],
        2,
      ),
    ).toThrow('group group-a is proposed twice');
  });

  it('requires one human disposition per group and refuses confirmation of manual review', async () => {
    const routed = await routeInboundFax(
      new InMemoryBlobStore(),
      [],
      routeInput(),
      ports(inspection()),
    );
    expect(() =>
      confirmFaxRouting(routed, {
        tenantId,
        confirmedBy: 'synthetic-staff:coordinator',
        confirmedAt: '2026-03-10T08:05:00Z',
        evidenceRef: 'synthetic-confirmation:fax-9001',
        dispositions: [],
      }),
    ).toThrow('every proposed group exactly once');

    const subThreshold = await routeInboundFax(
      new InMemoryBlobStore(),
      [],
      routeInput(),
      ports(inspection({ groups: [{ ...primaryGroup(), confidence: 0.5 }] })),
    );
    expect(() =>
      confirmFaxRouting(subThreshold, {
        tenantId,
        confirmedBy: 'synthetic-staff:coordinator',
        confirmedAt: '2026-03-10T08:05:00Z',
        evidenceRef: 'synthetic-confirmation:fax-9001',
        dispositions: [
          {
            kind: 'confirm',
            groupId: 'group-a',
            personRef: 'synthetic-person:a',
            pages: [1, 2],
            documentType: 'referral',
          },
        ],
      }),
    ).toThrow('manual-review and cannot be confirmed');
  });

  it('rejects unknown disposition kinds at the runtime boundary', async () => {
    const routed = await routeInboundFax(
      new InMemoryBlobStore(),
      [],
      routeInput(),
      ports(inspection()),
    );
    expect(() =>
      confirmFaxRouting(routed, {
        tenantId,
        confirmedBy: 'synthetic-staff:coordinator',
        confirmedAt: '2026-03-10T08:05:00Z',
        evidenceRef: 'synthetic-confirmation:fax-9001',
        dispositions: [
          {
            kind: 'typo',
            groupId: 'group-a',
            pages: [1, 2],
            reasonRef: 'synthetic-reason:invalid',
          },
        ] as never,
      }),
    ).toThrow('unknown kind');
  });

  it('rejects raw values disguised as observable attribute names', async () => {
    await expect(
      routeInboundFax(
        new InMemoryBlobStore(),
        [],
        routeInput(),
        ports(
          inspection({
            groups: [
              {
                ...primaryGroup(),
                identityEvidence: {
                  ...primaryGroup().identityEvidence,
                  observedAttributeNames: ['patient-name:raw-value'] as never,
                },
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow('attribute names only');

    const configured: FaxRoutingPorts = {
      ...ports(inspection()),
      matcher: {
        async resolve() {
          return {
            kind: 'single',
            tenantId,
            personRef: 'synthetic-person:a',
            matchedAttributeNames: ['patient-name:raw-value'] as never,
          };
        },
      },
    };
    await expect(
      routeInboundFax(new InMemoryBlobStore(), [], routeInput(), configured),
    ).rejects.toThrow('attribute names only');
  });

  it('rejects impossible calendar instants instead of allowing Date normalization', async () => {
    await expect(
      routeInboundFax(
        new InMemoryBlobStore(),
        [],
        routeInput({ delivery: delivery({ receivedAt: '2026-02-30T08:00:00Z' }) }),
        ports(inspection()),
      ),
    ).rejects.toThrow('real ISO-8601 UTC instant');
  });

  it('opens urgent work before rejecting malformed page grouping', async () => {
    const trace: string[] = [];
    await expect(
      routeInboundFax(
        new InMemoryBlobStore(),
        [],
        routeInput(),
        ports(
          inspection({
            groups: [{ ...primaryGroup(), pages: [1, 1, 2] }],
            urgency: { signal: 'positive', evidenceRef: 'synthetic-urgency:positive' },
          }),
          trace,
        ),
      ),
    ).rejects.toThrow('page 1 is assigned twice');
    expect(trace).toEqual(['urgent-screen', 'urgent-work-item']);
  });

  it('replays an exact received event without duplicating intake or urgent work', async () => {
    const store = new InMemoryBlobStore();
    const trace: string[] = [];
    const configured = ports(
      inspection({ urgency: { signal: 'positive', evidenceRef: 'synthetic-urgency:positive' } }),
      trace,
    );
    const first = await routeInboundFax(store, [], routeInput(), configured);
    const replay = await routeInboundFax(store, first.log, routeInput(), configured);
    expect(replay.log).toEqual(first.log);
    expect(trace).toEqual([
      'urgent-screen',
      'urgent-work-item',
      'identity-resolution',
      'urgent-screen',
      'identity-resolution',
    ]);
  });

  it('fails closed on tenant mismatches from delivery, inspection, and matcher', async () => {
    await expect(
      routeInboundFax(
        new InMemoryBlobStore(),
        [],
        routeInput({ delivery: delivery({ tenantId: 'riverbend-synthetic' }) }),
        ports(inspection()),
      ),
    ).rejects.toThrow('delivery tenant');

    await expect(
      routeInboundFax(
        new InMemoryBlobStore(),
        [],
        routeInput(),
        ports(inspection({ tenantId: 'riverbend-synthetic' })),
      ),
    ).rejects.toThrow('inspection tenant/subject');

    const mismatched: FaxRoutingPorts = {
      ...ports(inspection()),
      matcher: {
        async resolve() {
          return { kind: 'none', tenantId: 'riverbend-synthetic' };
        },
      },
    };
    await expect(
      routeInboundFax(new InMemoryBlobStore(), [], routeInput(), mismatched),
    ).rejects.toThrow('crossed the routing tenant');
  });
});

describe('urgent sweep and sender pattern', () => {
  const urgent = (
    documentId: string,
    signal: 'positive' | 'uncertain',
    dueAt: string,
  ): FaxUrgentWorkDescriptor => ({
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
  });

  it('includes the exact due boundary and sorts positive before uncertain', () => {
    const swept = sweepUrgentFaxReviews(
      [
        urgent('nd-uncertain', 'uncertain', '2026-03-10T08:10:00Z'),
        urgent('nd-positive', 'positive', '2026-03-10T08:15:00Z'),
      ],
      '2026-03-10T08:15:00Z',
    );
    expect(swept.map((item) => item.documentId)).toEqual(['nd-positive', 'nd-uncertain']);
  });

  it('refuses a cross-tenant sweep', () => {
    expect(() =>
      sweepUrgentFaxReviews(
        [
          urgent('nd-a', 'positive', '2026-03-10T08:10:00Z'),
          {
            ...urgent('nd-b', 'positive', '2026-03-10T08:10:00Z'),
            tenantId: 'riverbend-synthetic',
          },
        ],
        '2026-03-10T08:15:00Z',
      ),
    ).toThrow('one tenant scope');
  });

  it('flags recurring unmatched senders without weakening per-fax policy', () => {
    const result = evaluateFaxSenderPattern({
      tenantId,
      senderRef: 'synthetic-sender:partner-a',
      outcomes: [{ outcome: 'unmatched' }, { outcome: 'matched' }, { outcome: 'unidentifiable' }],
      outreachThreshold: 2,
      perSenderNoteRef: 'synthetic-note:partner-a',
      perFaxMinimumConfidence: 0.9,
    });
    expect(result).toMatchObject({
      flagPracticeManagerOutreach: true,
      patternCount: 2,
      perFaxMinimumConfidence: 0.9,
      matchPolicyUnchanged: true,
    });
  });
});
