import { InMemoryBlobStore, routeInboundFax, type FaxWorkItemPort } from '@practicehub/documents';
import { describe, expect, it } from 'vitest';

import {
  createFaxIntelligenceDouble,
  createFaxPatientMatchDouble,
  createFaxWorkItemDouble,
  type FaxIntelligenceScenario,
} from './intelligence-double.js';

const tenantId = 'northwind-synthetic';

async function route(
  scenario: FaxIntelligenceScenario,
  trace: string[] = [],
  workItems: FaxWorkItemPort = createFaxWorkItemDouble(trace),
) {
  return routeInboundFax(
    new InMemoryBlobStore(),
    [],
    {
      tenantId,
      documentId: `nd-${scenario}`,
      documentEventId: `nde-${scenario}`,
      actorRef: 'synthetic-fax-gateway',
      delivery: {
        tenantId,
        faxId: `fax-${scenario}`,
        senderRef: 'synthetic-sender:clinic-a',
        pageCount: scenario === 'multi-patient' ? 4 : 2,
        bytes: `synthetic-fax-content:${scenario}`,
        mediaType: 'application/pdf',
        receivedAt: '2026-03-10T08:00:00Z',
        synthetic: true,
      },
      minimumConfidence: 0.9,
      urgentDueAt: '2026-03-10T08:15:00Z',
      afterHoursRouteRef: 'synthetic-oncall:fax',
    },
    {
      intelligence: {
        async inspect(input) {
          trace.push('urgent-screen');
          return createFaxIntelligenceDouble(scenario).inspect(input);
        },
      },
      matcher: {
        async resolve(input) {
          trace.push('identity-resolution');
          return createFaxPatientMatchDouble(scenario).resolve(input);
        },
      },
      workItems,
    },
  );
}

describe('fax intelligence doubles', () => {
  it.each([
    ['single-match', ['awaiting-human-confirmation']],
    ['multi-patient', ['awaiting-human-confirmation', 'awaiting-human-confirmation']],
    ['ambiguous', ['manual-review']],
    ['sub-threshold', ['manual-review']],
  ] as const)('drives deterministic %s routing', async (scenario, expectedKinds) => {
    const result = await route(scenario);
    expect(result.groups.map((group) => group.kind)).toEqual(expectedKinds);
    expect(result.synthetic).toBe(true);
  });

  it('opens positive urgent work before identity resolution', async () => {
    const trace: string[] = [];
    const result = await route('urgent', trace);
    expect(trace).toEqual(['urgent-screen', `urgent:${tenantId}:nd-urgent`, 'identity-resolution']);
    expect(result.urgentWork?.signal).toBe('positive');
  });

  it('opens uncertain urgent work for unreadable content without matching', async () => {
    const trace: string[] = [];
    const result = await route('unreadable-urgent', trace);
    expect(trace).toEqual(['urgent-screen', `urgent:${tenantId}:nd-unreadable-urgent`]);
    expect(result.groups[0]).toMatchObject({ kind: 'manual-review', reason: 'unreadable' });
    expect(result.urgentWork?.signal).toBe('uncertain');
  });

  it('deduplicates urgent external work across a replay with no caller log', async () => {
    const trace: string[] = [];
    const workItems = createFaxWorkItemDouble(trace);
    await route('urgent', trace, workItems);
    await route('urgent', trace, workItems);
    expect(trace.filter((entry) => entry.startsWith('urgent:'))).toEqual([
      `urgent:${tenantId}:nd-urgent`,
    ]);
  });
});
