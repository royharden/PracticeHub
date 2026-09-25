import { describe, expect, it } from 'vitest';

import { ErxEmbed, ErxError, fixtureVendorId, wp062MedicationListPlaceholder } from './erx.js';

const medicationRef = wp062MedicationListPlaceholder.fixtureId;

describe('WP-066 eRx vendor embed', () => {
  it('completes the vendor flow against the fixture vendor', () => {
    const embed = new ErxEmbed();
    expect(
      embed.transmit({
        vendorId: fixtureVendorId,
        kind: 'new',
        jurisdiction: 'FL',
        itemId: 'rx-new-1',
        medicationRef,
      }),
    ).toEqual({ completed: true });
    expect(embed.refillQueue).toEqual([]);
    expect(embed.renewalQueue).toEqual([]);
    expect(() =>
      embed.transmit({
        vendorId: 'other-vendor',
        kind: 'new',
        jurisdiction: 'FL',
        itemId: 'rx-new-2',
        medicationRef,
      }),
    ).toThrowError(new ErxError('UNKNOWN_VENDOR'));
  });

  it('lands refills and renewals in separate queues', () => {
    const embed = new ErxEmbed();
    embed.transmit({
      vendorId: fixtureVendorId,
      kind: 'refill',
      jurisdiction: 'FL',
      itemId: 'rx-refill-1',
      medicationRef,
    });
    embed.transmit({
      vendorId: fixtureVendorId,
      kind: 'renewal',
      jurisdiction: 'FL',
      itemId: 'rx-renewal-1',
      medicationRef,
    });
    expect(embed.refillQueue).toEqual([{ itemId: 'rx-refill-1', kind: 'refill', medicationRef }]);
    expect(embed.renewalQueue).toEqual([
      { itemId: 'rx-renewal-1', kind: 'renewal', medicationRef },
    ]);
  });

  it('blocks a transmit the jurisdiction fixture marks illegal', () => {
    const embed = new ErxEmbed();
    expect(
      embed.transmit({
        vendorId: fixtureVendorId,
        kind: 'refill',
        jurisdiction: 'XX',
        itemId: 'rx-blocked-1',
        medicationRef,
      }),
    ).toEqual({ completed: false, blocked: 'jurisdiction' });
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
