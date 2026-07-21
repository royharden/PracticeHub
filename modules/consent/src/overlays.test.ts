import { jurisdictionPacksV1 } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  communicationOverlay,
  consentBasis,
  geneticAuthorizationOverlay,
  jurisdictionToPatientState,
  recordsConsentOverlay,
} from './overlays.js';

const packs = jurisdictionPacksV1;

describe('jurisdictionToPatientState', () => {
  it('maps a state through and virtual to unknown', () => {
    expect(jurisdictionToPatientState('MN')).toBe('MN');
    expect(jurisdictionToPatientState('virtual')).toBeNull();
  });
});

describe('recordsConsentOverlay', () => {
  it('surfaces the MHRA consent-expiry scalar and written-consent for MN (R6-SR-040/041)', () => {
    const overlay = recordsConsentOverlay(packs, consentBasis('MN', 'MN'));
    expect(overlay.consentExpiryDays).toBe(365);
    expect(overlay.requiresWrittenConsent).toBe(true);
    expect(overlay.counselReviewPending).toBe(true); // v1 packs are draft
    expect(overlay.defaultsApplied).toBe(false);
  });

  it('a virtual/unknown patient resolves through the safe defaults', () => {
    const overlay = recordsConsentOverlay(packs, consentBasis('virtual'));
    expect(overlay.defaultsApplied).toBe(true);
    expect(overlay.obligations.length).toBeGreaterThan(0);
  });
});

describe('communicationOverlay', () => {
  it('requires CHD opt-in for a marketing send (NV SB370 + floor, R6-SR-020)', () => {
    const overlay = communicationOverlay(packs, consentBasis('NV', 'NV'), 'marketing', 'sms');
    expect(overlay.chdOptInRequired).toBe(true);
  });

  it('requires AI disclosure for an ai_voice channel (FCC 24-17 floor, R6-REQ-074)', () => {
    const overlay = communicationOverlay(packs, consentBasis('NV', 'NV'), 'treatment', 'ai_voice');
    expect(overlay.aiDisclosureRequired).toBe(true);
  });

  it('a plain treatment sms send pulls neither marketing nor ai obligations', () => {
    const overlay = communicationOverlay(packs, consentBasis('NV', 'NV'), 'treatment', 'sms');
    expect(overlay.chdOptInRequired).toBe(false);
    expect(overlay.aiDisclosureRequired).toBe(false);
  });
});

describe('geneticAuthorizationOverlay', () => {
  it('requires GIPA written authorization everywhere (floor, R6-SR-031)', () => {
    for (const jurisdiction of ['NV', 'FL', 'IL', 'MN'] as const) {
      const overlay = geneticAuthorizationOverlay(packs, consentBasis(jurisdiction, jurisdiction));
      expect(overlay.writtenAuthorizationRequired, jurisdiction).toBe(true);
    }
  });
});
