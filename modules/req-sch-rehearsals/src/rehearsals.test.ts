import { describe, expect, it } from 'vitest';

import {
  acceptOffer,
  confirmPreferredChannel,
  presentEquivalentOptions,
  sameDayOffers,
} from './rehearsals.js';
import { SchRehearsalError } from './types.js';

describe('REQ-SCH leftover rehearsals', () => {
  it('presents equivalent options for one slot (002.AC3)', () => {
    const options = presentEquivalentOptions([
      { optionId: 'a', slotRef: 'slot-1', label: 'Clinician A' },
      { optionId: 'b', slotRef: 'slot-1', label: 'Clinician B' },
    ]);
    expect(options).toHaveLength(2);
    expect(new Set(options.map((option) => option.slotRef))).toEqual(new Set(['slot-1']));
  });

  it('rejects equivalent options that span two slots', () => {
    expect(() =>
      presentEquivalentOptions([
        { optionId: 'a', slotRef: 'slot-1', label: 'A' },
        { optionId: 'b', slotRef: 'slot-2', label: 'B' },
      ]),
    ).toThrow('DUPLICATE_SLOT');
  });

  it('confirms a preferred channel token without live SMS (003.AC2)', () => {
    expect(confirmPreferredChannel('sms')).toBe('sms');
    expect(() => confirmPreferredChannel('carrier-pigeon')).toThrow(SchRehearsalError);
  });

  it('lists same-day multi-offers (021)', () => {
    const offers = sameDayOffers('2026-09-18', [
      {
        offerId: 'o1',
        slotRef: 'slot-1',
        expiresAt: '2026-09-18T18:00:00.000Z',
        channel: 'sms',
      },
      {
        offerId: 'o2',
        slotRef: 'slot-2',
        expiresAt: '2026-09-19T18:00:00.000Z',
        channel: 'email',
      },
    ]);
    expect(offers.map((offer) => offer.offerId)).toEqual(['o1']);
  });

  it('refuses an expired offer (022)', () => {
    const offer = {
      offerId: 'o1',
      slotRef: 'slot-1',
      expiresAt: '2026-09-18T12:00:00.000Z',
      channel: 'sms' as const,
    };
    expect(acceptOffer(offer, '2026-09-18T11:59:59.000Z').offerId).toBe('o1');
    expect(() => acceptOffer(offer, '2026-09-18T12:00:00.000Z')).toThrow('EXPIRED_OFFER');
  });
});
