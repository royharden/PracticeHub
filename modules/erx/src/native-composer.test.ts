import { describe, expect, it } from 'vitest';

import {
  ComposerError,
  composeNativeShadow,
  composePayload,
  epcsSimulator,
} from './native-composer.js';
import { wp062MedicationListPlaceholder } from './erx.js';

const draft = {
  draftId: 'rx-shadow-1',
  prescriberNpi: '1234567893',
  medicationRef: wp062MedicationListPlaceholder.fixtureId,
  sig: '1 tab daily',
  jurisdiction: 'FL',
} as const;

const factors = { password: epcsSimulator.password, token: epcsSimulator.token };

describe('WP-067 native composer shadow harness', () => {
  it('matches native and shadow composition and transmits nothing', () => {
    const shadow = composeNativeShadow([draft], factors);
    expect(shadow.transmits).toBe(0);
    expect(shadow.pdmpChecks).toBe(1);
    expect(shadow.composed).toEqual([composePayload(draft)]);
    expect(JSON.stringify(shadow.composed[0])).toBe(JSON.stringify(composePayload(draft)));
  });

  it('rejects EPCS when the simulator does not get both factors', () => {
    expect(() =>
      composeNativeShadow([draft], { password: factors.password, token: '' }),
    ).toThrowError(new ComposerError('EPCS_DENIED'));
  });
});
