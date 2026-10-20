import { describe, expect, it } from 'vitest';

import {
  ERX_JURISDICTION_TOPIC,
  ErxEmbed,
  ErxError,
  fixtureJurisdictionPort,
  fixtureVendorId,
  JURISDICTION_HARD_BLOCK,
  wp062MedicationListPlaceholder,
  type ErxTransmitInput,
} from './erx.js';

const medicationRef = wp062MedicationListPlaceholder.fixtureId;
const tenantId = 'tenant-synth-01';

function tx(overrides: Partial<ErxTransmitInput> = {}): ErxTransmitInput {
  return {
    tenantId,
    vendorId: fixtureVendorId,
    kind: 'refill',
    jurisdiction: 'FL',
    itemId: 'rx-1',
    medicationRef,
    ...overrides,
  };
}

describe('WP-066 eRx vendor embed', () => {
  it('completes the vendor flow against the fixture vendor', () => {
    const embed = new ErxEmbed();
    expect(embed.transmit(tx({ kind: 'new', itemId: 'rx-new-1' }))).toEqual({ completed: true });
    expect(embed.refillQueue).toEqual([]);
    expect(embed.renewalQueue).toEqual([]);
    expect(() =>
      embed.transmit(tx({ vendorId: 'other-vendor', kind: 'new', itemId: 'rx-new-2' })),
    ).toThrowError(new ErxError('UNKNOWN_VENDOR'));
  });

  it('lands refills and renewals in separate queues, scoped to the tenant', () => {
    const embed = new ErxEmbed();
    embed.transmit(tx({ itemId: 'rx-refill-1' }));
    embed.transmit(tx({ kind: 'renewal', itemId: 'rx-renewal-1' }));
    expect(embed.refillQueue).toEqual([
      { tenantId, itemId: 'rx-refill-1', kind: 'refill', medicationRef },
    ]);
    expect(embed.renewalQueue).toEqual([
      { tenantId, itemId: 'rx-renewal-1', kind: 'renewal', medicationRef },
    ]);
  });

  it('blocks a transmit the jurisdiction fixture marks illegal', () => {
    const embed = new ErxEmbed();
    expect(embed.transmit(tx({ jurisdiction: 'XX', itemId: 'rx-blocked-1' }))).toEqual({
      completed: false,
      blocked: 'jurisdiction',
    });
    expect(embed.refillQueue).toEqual([]);
    expect(embed.renewalQueue).toEqual([]);
  });

  it('names the WP-062 medication-list placeholder', () => {
    expect(wp062MedicationListPlaceholder).toEqual({
      packageId: 'WP-062',
      typeName: 'MedicationList',
      fixtureId: 'wp062-medication-list',
    });
  });
});

describe('WP-066 transmit idempotency (review F1)', () => {
  it('a refill and a renewal each transmitted twice leave one queued item per id', () => {
    const embed = new ErxEmbed();
    const first = embed.transmit(tx({ itemId: 'rx-1' }));
    const again = embed.transmit(tx({ itemId: 'rx-1' }));
    embed.transmit(tx({ kind: 'renewal', itemId: 'rx-2' }));
    embed.transmit(tx({ kind: 'renewal', itemId: 'rx-2' }));
    expect(again).toEqual(first);
    expect(embed.refillQueue.map((item) => item.itemId)).toEqual(['rx-1']);
    expect(embed.renewalQueue.map((item) => item.itemId)).toEqual(['rx-2']);
  });

  it('a repeated new prescription is also a no-op after the first', () => {
    const embed = new ErxEmbed();
    expect(embed.transmit(tx({ kind: 'new', itemId: 'rx-3' }))).toEqual({ completed: true });
    expect(embed.transmit(tx({ kind: 'new', itemId: 'rx-3' }))).toEqual({ completed: true });
    expect(() => embed.transmit(tx({ kind: 'refill', itemId: 'rx-3' }))).toThrowError(
      new ErxError('IDEMPOTENCY_CONFLICT'),
    );
  });

  it.each([
    ['a different medication', { medicationRef: 'other-med' }],
    ['a different kind', { kind: 'renewal' as const }],
    ['a different jurisdiction', { jurisdiction: 'NV' }],
  ])('refuses the same itemId with %s and queues nothing more', (_label, change) => {
    const embed = new ErxEmbed(
      fixtureJurisdictionPort([
        { jurisdiction: 'FL', transmitLegal: true },
        { jurisdiction: 'NV', transmitLegal: true },
      ]),
    );
    embed.transmit(tx({ itemId: 'rx-1' }));
    expect(() => embed.transmit(tx({ itemId: 'rx-1', ...change }))).toThrowError(
      new ErxError('IDEMPOTENCY_CONFLICT'),
    );
    expect(embed.refillQueue).toHaveLength(1);
    expect(embed.renewalQueue).toHaveLength(0);
  });

  it('keys idempotency by tenant: the same itemId in two tenants is two items', () => {
    const embed = new ErxEmbed();
    embed.transmit(tx({ itemId: 'rx-1' }));
    embed.transmit(tx({ itemId: 'rx-1', tenantId: 'tenant-synth-02' }));
    expect(embed.refillQueue.map((item) => [item.tenantId, item.itemId])).toEqual([
      [tenantId, 'rx-1'],
      ['tenant-synth-02', 'rx-1'],
    ]);
  });

  it('a blocked transmit sends nothing and is re-judged on retry', () => {
    const legal = { value: false };
    const embed = new ErxEmbed({
      resolve: (jurisdiction) => ({
        topic: ERX_JURISDICTION_TOPIC,
        jurisdiction,
        resolved: true,
        obligations: legal.value ? [] : [JURISDICTION_HARD_BLOCK],
      }),
    });
    expect(embed.transmit(tx())).toEqual({ completed: false, blocked: 'jurisdiction' });
    legal.value = true;
    expect(embed.transmit(tx())).toEqual({ completed: true });
    expect(embed.refillQueue).toHaveLength(1);
  });

  it('refuses a malformed tenant, itemId or medication reference', () => {
    const embed = new ErxEmbed();
    expect(() => embed.transmit(tx({ tenantId: '' }))).toThrowError(new ErxError('INVALID_INPUT'));
    expect(() => embed.transmit(tx({ itemId: 'bad id' }))).toThrowError(
      new ErxError('INVALID_INPUT'),
    );
    expect(() => embed.transmit(tx({ medicationRef: '' }))).toThrowError(
      new ErxError('INVALID_INPUT'),
    );
  });
});

describe('WP-066 jurisdiction port (review F2 seam)', () => {
  it('blocks an unknown jurisdiction, a hard-block obligation, and a decision for another topic', () => {
    expect(new ErxEmbed().transmit(tx({ jurisdiction: 'ZZ' }))).toEqual({
      completed: false,
      blocked: 'jurisdiction',
    });
    const hard = new ErxEmbed({
      resolve: (jurisdiction) => ({
        topic: ERX_JURISDICTION_TOPIC,
        jurisdiction,
        resolved: true,
        obligations: ['pdmp-check', JURISDICTION_HARD_BLOCK],
      }),
    });
    expect(hard.transmit(tx())).toEqual({ completed: false, blocked: 'jurisdiction' });
    const wrongTopic = new ErxEmbed({
      resolve: (jurisdiction) => ({
        topic: 'telehealth-licensure' as unknown as typeof ERX_JURISDICTION_TOPIC,
        jurisdiction,
        resolved: true,
        obligations: [],
      }),
    });
    expect(wrongTopic.transmit(tx())).toEqual({ completed: false, blocked: 'jurisdiction' });
  });

  it('the fixture port resolves FL legal and XX with the platform hard-block obligation', () => {
    const port = fixtureJurisdictionPort();
    expect(port.resolve('FL')).toEqual({
      topic: 'erx-epcs-pdmp',
      jurisdiction: 'FL',
      resolved: true,
      obligations: ['erx-mandate'],
    });
    expect(port.resolve('XX').obligations).toEqual(['jurisdiction-unverified-hard-block']);
    expect(port.resolve('ZZ').resolved).toBe(false);
  });
});
