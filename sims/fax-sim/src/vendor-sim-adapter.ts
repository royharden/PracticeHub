/**
 * Test-only bridge from the module-owned InboundFaxPort to RAIL-005's normalized
 * scenario surface. Product modules never import the simulator service.
 */

import type { InboundFaxDelivery, InboundFaxPort } from '@practicehub/documents';

export interface FaxRailRequest {
  readonly railId: 'RAIL-005';
  readonly operation: 'fetch-inbound-fax';
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
  readonly synthetic: true;
}

export interface FaxRailInboundResult {
  readonly railId: 'RAIL-005';
  readonly status: 'accepted' | 'deduplicated' | 'uncertain' | 'unavailable' | 'malformed';
  readonly idempotencyKey: string;
  readonly delivery: InboundFaxDelivery | null;
  readonly resendsExternalEffect: false;
  readonly synthetic: true;
}

export interface FaxRailScenarioPort {
  fetchInbound(request: FaxRailRequest): FaxRailInboundResult;
}

export function createVendorSimFaxAdapter(input: {
  readonly tenantId: string;
  readonly pollKey: string;
  readonly requestedAt: string;
  readonly rail: FaxRailScenarioPort;
}): InboundFaxPort {
  return {
    poll(): readonly InboundFaxDelivery[] {
      const result = input.rail.fetchInbound({
        railId: 'RAIL-005',
        operation: 'fetch-inbound-fax',
        tenantId: input.tenantId,
        idempotencyKey: input.pollKey,
        requestedAt: input.requestedAt,
        synthetic: true,
      });
      if (result.synthetic !== true || result.railId !== 'RAIL-005') {
        throw new Error('fax rail response is not a synthetic RAIL-005 result');
      }
      if (result.resendsExternalEffect !== false) {
        throw new Error('fax rail response may not resend an external effect');
      }
      if (
        result.status !== 'accepted' &&
        result.status !== 'deduplicated' &&
        result.status !== 'uncertain' &&
        result.status !== 'unavailable' &&
        result.status !== 'malformed'
      ) {
        throw new Error('fax rail returned an unknown status');
      }
      if (result.idempotencyKey !== input.pollKey) {
        throw new Error('fax rail response idempotency key does not match the poll');
      }
      if (result.status === 'uncertain' || result.status === 'unavailable') {
        return [];
      }
      if (result.status === 'malformed' || result.delivery === null) {
        throw new Error('fax rail returned no valid inbound delivery');
      }
      if (result.delivery.tenantId !== input.tenantId) {
        throw new Error('fax rail delivery crossed tenant scope');
      }
      if (result.delivery.synthetic !== true) {
        throw new Error('fax rail delivery must carry the synthetic watermark');
      }
      return [result.delivery];
    },
  };
}
