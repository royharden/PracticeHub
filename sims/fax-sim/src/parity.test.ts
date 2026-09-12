import {
  InMemoryBlobStore,
  routeInboundFax,
  type FaxPatientMatchPort,
  type FaxWorkItemPort,
  type InboundFaxDelivery,
} from '@practicehub/documents';
import { describe, expect, it } from 'vitest';

import {
  createFaxIntelligenceDouble,
  createFaxPatientMatchDouble,
  type FaxIntelligenceScenario,
} from './intelligence-double.js';
import { createVendorSimFaxAdapter, type FaxRailScenarioPort } from './vendor-sim-adapter.js';

const scenarios: readonly FaxIntelligenceScenario[] = [
  'single-match',
  'multi-patient',
  'ambiguous',
  'sub-threshold',
  'unreadable-urgent',
  'urgent',
  'uncertain-urgent',
];

const vendorSimulatorUrl = new URL('../../vendor-simulator/dist/index.js', import.meta.url).href;
const vendorSimKitUrl = new URL('../../vendor-sim-kit/dist/index.js', import.meta.url).href;
const identityUrl = new URL('../../../modules/identity/dist/index.js', import.meta.url).href;
const eventsUrl = new URL('../../../modules/events/dist/index.js', import.meta.url).href;

interface ActualRailResponse {
  readonly status: string;
  readonly idempotencyKey: string;
  readonly resendsExternalEffect: false;
}

interface ActualVendorEngine {
  dispatch(input: {
    readonly railId: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly payloadRef: string;
    readonly requestedAt: string;
    readonly payload: unknown;
    readonly synthetic: true;
  }): ActualRailResponse;
}

interface ActualIdentityModule {
  findIdentityCandidates(
    attributes: Readonly<Record<string, string>>,
    existing: readonly unknown[],
  ): readonly {
    readonly personId: string;
    readonly matchedAttributes: readonly string[];
  }[];
}

interface ActualEventsModule {
  initialWorkItem(open: {
    readonly workItemId: string;
    readonly origin: 'admin';
    readonly subjectRef: string;
    readonly purpose: string;
    readonly risk: 'urgent' | 'critical';
    readonly serviceTier: string;
    readonly slaPolicyId: string;
    readonly policyVersion: number;
    readonly responseDueAt: string;
    readonly poolId: string;
    readonly openedAt: string;
  }): {
    readonly subjectRef: string | null;
    readonly purpose: string;
    readonly risk: string;
    readonly hasSla: boolean;
    readonly responseDueAt: string | null;
  };
  computeTimerState(
    timer: {
      readonly timerType: 'first_response';
      readonly startedAt: string;
      readonly dueAt: string;
      readonly pausedTotalSeconds: number;
      readonly state: 'running';
    },
    nowIso: string,
  ): string;
}

const delivery: InboundFaxDelivery = {
  tenantId: 'northwind-synthetic',
  faxId: 'synthetic-fax-parity',
  senderRef: 'synthetic-sender:parity',
  pageCount: 2,
  bytes: 'synthetic-fax-content:parity',
  mediaType: 'application/pdf',
  receivedAt: '2026-03-10T08:00:00Z',
  synthetic: true,
};

describe('synthetic fax intelligence parity boundary', () => {
  it.each(scenarios)('labels %s with an explicit real-provider parity case', async (scenario) => {
    const result = await createFaxIntelligenceDouble(scenario).inspect({
      tenantId: 'northwind-synthetic',
      faxId: `fax-${scenario}`,
      documentId: `nd-${scenario}`,
      senderRef: 'synthetic-sender:parity',
      blobRef: `synthetic-blob:${scenario}`,
      contentHash: '0123456789abcdef',
      pageCount: scenario === 'multi-patient' ? 4 : 2,
      receivedAt: '2026-03-10T08:00:00Z',
      synthetic: true,
    });
    expect(result).toMatchObject({
      providerRef: 'synthetic-idp:fax-double',
      providerVersion: 'synthetic-idp-v1',
      realParityCase: `fax-parity:${scenario}`,
      synthetic: true,
    });
  });

  it('keeps urgent, uncertain, and negative signals distinct for parity reconciliation', async () => {
    const inspect = async (scenario: FaxIntelligenceScenario) =>
      createFaxIntelligenceDouble(scenario).inspect({
        tenantId: 'northwind-synthetic',
        faxId: `fax-${scenario}`,
        documentId: `nd-${scenario}`,
        senderRef: 'synthetic-sender:parity',
        blobRef: `synthetic-blob:${scenario}`,
        contentHash: '0123456789abcdef',
        pageCount: 2,
        receivedAt: '2026-03-10T08:00:00Z',
        synthetic: true,
      });
    expect((await inspect('urgent')).urgency.signal).toBe('positive');
    expect((await inspect('uncertain-urgent')).urgency.signal).toBe('uncertain');
    expect((await inspect('single-match')).urgency.signal).toBe('negative');
  });

  it('binds RAIL-005 delivery and idempotency to the actual vendor simulator engine', async () => {
    const vendor = (await import(vendorSimulatorUrl)) as {
      readonly railSimsV1: readonly unknown[];
    };
    const kit = (await import(vendorSimKitUrl)) as {
      readonly VendorSimEngine: new (input: {
        readonly rails: readonly unknown[];
      }) => ActualVendorEngine;
    };
    const engine = new kit.VendorSimEngine({ rails: vendor.railSimsV1 });
    const statuses: string[] = [];
    const rail: FaxRailScenarioPort = {
      fetchInbound(request) {
        const response = engine.dispatch({
          railId: request.railId,
          operation: request.operation,
          idempotencyKey: request.idempotencyKey,
          payloadRef: `synthetic-fax-payload:${request.tenantId}`,
          requestedAt: request.requestedAt,
          payload: delivery,
          synthetic: true,
        });
        statuses.push(response.status);
        if (response.status !== 'accepted' && response.status !== 'deduplicated') {
          throw new Error(`unexpected clean RAIL-005 status ${response.status}`);
        }
        return {
          railId: 'RAIL-005',
          status: response.status,
          idempotencyKey: response.idempotencyKey,
          delivery,
          resendsExternalEffect: response.resendsExternalEffect,
          synthetic: true,
        };
      },
    };
    const adapter = createVendorSimFaxAdapter({
      tenantId: delivery.tenantId,
      pollKey: 'synthetic-fax-poll-parity',
      requestedAt: delivery.receivedAt,
      rail,
    });
    expect(adapter.poll()).toEqual([delivery]);
    expect(adapter.poll()).toEqual([delivery]);
    expect(statuses).toEqual(['accepted', 'deduplicated']);
  });

  it('maps real identity candidates into the same human-confirmation boundary', async () => {
    const identity = (await import(identityUrl)) as ActualIdentityModule;
    const matcher: FaxPatientMatchPort = {
      async resolve(input) {
        const candidates = identity.findIdentityCandidates(
          {
            givenName: input.evidence.facts['given-name'] ?? '',
            familyName: input.evidence.facts['family-name'] ?? '',
            birthDate: input.evidence.facts['birth-date'] ?? '',
          },
          [
            {
              person: {
                personId: 'synthetic-person:actual-matcher',
                tenantId: input.tenantId,
                status: 'provisional',
                provenance: { source: 'synthetic-intake', capturedBy: 'synthetic-parity' },
                synthetic: true,
              },
              names: [],
              attributes: {
                givenName: 'synthetic-given-all',
                familyName: 'synthetic-family-all',
                birthDate: '1980-01-01',
              },
            },
          ],
        );
        const candidate = candidates[0];
        if (candidate === undefined) {
          return { kind: 'none', tenantId: input.tenantId };
        }
        return {
          kind: 'single',
          tenantId: input.tenantId,
          personRef: candidate.personId,
          matchedAttributeNames: ['patient-name', 'date-of-birth'],
        };
      },
    };
    const result = await routeInboundFax(
      new InMemoryBlobStore(),
      [],
      {
        tenantId: delivery.tenantId,
        documentId: 'nd-actual-identity-parity',
        documentEventId: 'nde-actual-identity-parity',
        actorRef: 'synthetic-fax-gateway',
        delivery,
        minimumConfidence: 0.9,
        urgentDueAt: '2026-03-10T08:15:00Z',
        afterHoursRouteRef: 'synthetic-oncall:fax',
      },
      {
        intelligence: createFaxIntelligenceDouble('single-match'),
        matcher,
        workItems: {
          async openUrgent() {
            throw new Error('negative urgency must not open work');
          },
        },
      },
    );
    expect(result.groups[0]).toMatchObject({
      kind: 'awaiting-human-confirmation',
      proposedPersonRef: 'synthetic-person:actual-matcher',
    });
  });

  it('maps an urgent descriptor through actual WP-022 work-item and SLA primitives', async () => {
    const events = (await import(eventsUrl)) as ActualEventsModule;
    const openedByKey = new Map<string, string>();
    const workItems: FaxWorkItemPort = {
      async openUrgent(input) {
        const prior = openedByKey.get(input.idempotencyKey);
        if (prior !== undefined) {
          return { workItemRef: prior, outcome: 'deduplicated', resendsExternalEffect: false };
        }
        const workItemRef = `synthetic-workitem:${input.documentId}`;
        const item = events.initialWorkItem({
          workItemId: workItemRef,
          origin: 'admin',
          subjectRef: input.subjectRef,
          purpose: input.purpose,
          risk: input.signal === 'positive' ? 'critical' : 'urgent',
          serviceTier: 'urgent-fax',
          slaPolicyId: 'urgent-fax-review-v1',
          policyVersion: 1,
          responseDueAt: input.dueAt,
          poolId: input.afterHoursRouteRef,
          openedAt: input.receivedAt,
        });
        expect(item).toMatchObject({
          subjectRef: input.subjectRef,
          purpose: 'urgent-fax-review',
          risk: 'critical',
          hasSla: true,
          responseDueAt: input.dueAt,
        });
        expect(
          events.computeTimerState(
            {
              timerType: 'first_response',
              startedAt: input.receivedAt,
              dueAt: input.dueAt,
              pausedTotalSeconds: 0,
              state: 'running',
            },
            input.dueAt,
          ),
        ).toBe('breached');
        openedByKey.set(input.idempotencyKey, workItemRef);
        return { workItemRef, outcome: 'opened', resendsExternalEffect: false };
      },
    };
    const route = () =>
      routeInboundFax(
        new InMemoryBlobStore(),
        [],
        {
          tenantId: delivery.tenantId,
          documentId: 'nd-actual-workitem-parity',
          documentEventId: 'nde-actual-workitem-parity',
          actorRef: 'synthetic-fax-gateway',
          delivery,
          minimumConfidence: 0.9,
          urgentDueAt: '2026-03-10T08:15:00Z',
          afterHoursRouteRef: 'synthetic-oncall:fax',
        },
        {
          intelligence: createFaxIntelligenceDouble('urgent'),
          matcher: createFaxPatientMatchDouble('urgent'),
          workItems,
        },
      );
    expect((await route()).urgentWork?.workItemRef).toBe(
      'synthetic-workitem:nd-actual-workitem-parity',
    );
    expect((await route()).urgentWork?.workItemRef).toBe(
      'synthetic-workitem:nd-actual-workitem-parity',
    );
    expect(openedByKey).toHaveLength(1);
  });
});
