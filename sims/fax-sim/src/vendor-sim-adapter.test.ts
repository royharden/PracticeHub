import type { InboundFaxDelivery } from '@practicehub/documents';
import { describe, expect, it, vi } from 'vitest';

import {
  createVendorSimFaxAdapter,
  type FaxRailInboundResult,
  type FaxRailScenarioPort,
} from './vendor-sim-adapter.js';

const tenantId = 'northwind-synthetic';
const delivery: InboundFaxDelivery = {
  tenantId,
  faxId: 'synthetic-fax-rail-1',
  senderRef: 'synthetic-sender:rail',
  pageCount: 2,
  bytes: 'synthetic-fax-content:rail',
  mediaType: 'application/pdf',
  receivedAt: '2026-03-10T08:00:00Z',
  synthetic: true,
};

function result(overrides: Partial<FaxRailInboundResult> = {}): FaxRailInboundResult {
  return {
    railId: 'RAIL-005',
    status: 'accepted',
    idempotencyKey: 'poll-001',
    delivery,
    resendsExternalEffect: false,
    synthetic: true,
    ...overrides,
  };
}

function adapter(rail: FaxRailScenarioPort) {
  return createVendorSimFaxAdapter({
    tenantId,
    pollKey: 'poll-001',
    requestedAt: '2026-03-10T08:00:00Z',
    rail,
  });
}

describe('vendor simulator fax adapter', () => {
  it('maps RAIL-005 accepted and deduplicated results without resending effects', () => {
    for (const status of ['accepted', 'deduplicated'] as const) {
      const fetchInbound = vi.fn(() => result({ status }));
      expect(adapter({ fetchInbound }).poll()).toEqual([delivery]);
      expect(fetchInbound).toHaveBeenCalledWith({
        railId: 'RAIL-005',
        operation: 'fetch-inbound-fax',
        tenantId,
        idempotencyKey: 'poll-001',
        requestedAt: '2026-03-10T08:00:00Z',
        synthetic: true,
      });
    }
  });

  it.each(['uncertain', 'unavailable'] as const)(
    'returns no delivery for %s outcomes',
    (status) => {
      expect(adapter({ fetchInbound: () => result({ status, delivery: null }) }).poll()).toEqual(
        [],
      );
    },
  );

  it('fails closed for malformed, cross-tenant, or mismatched idempotency results', () => {
    expect(() =>
      adapter({ fetchInbound: () => result({ status: 'malformed', delivery: null }) }).poll(),
    ).toThrow('no valid inbound delivery');
    expect(() =>
      adapter({
        fetchInbound: () => result({ delivery: { ...delivery, tenantId: 'riverbend-synthetic' } }),
      }).poll(),
    ).toThrow('crossed tenant scope');
    expect(() =>
      adapter({ fetchInbound: () => result({ idempotencyKey: 'poll-other' }) }).poll(),
    ).toThrow('idempotency key');
    expect(() =>
      adapter({
        fetchInbound: () =>
          result({ resendsExternalEffect: true } as unknown as Partial<FaxRailInboundResult>),
      }).poll(),
    ).toThrow('resend an external effect');
    expect(() =>
      adapter({
        fetchInbound: () =>
          result({ status: 'invented' } as unknown as Partial<FaxRailInboundResult>),
      }).poll(),
    ).toThrow('unknown status');
  });
});
