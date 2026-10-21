import { describe, expect, it } from 'vitest';

import {
  distanceFeet,
  evaluateCampaign,
  GEOFENCE_RULESET_V1,
  type CampaignPlan,
  type HealthcareFacility,
} from './geofence.js';

/** Synthetic facility coordinates; 1 degree of latitude is about 364,000 feet. */
const clinic: HealthcareFacility = {
  facilityId: 'synthetic-clinic-lv',
  location: { lat: 36.1, lon: -115.2 },
};
const feetNorth = (feet: number) => ({ lat: 36.1 + feet / 364_000, lon: -115.2 });

const geofence = (centerFeetNorth: number, radiusFeet: number): CampaignPlan => ({
  campaignId: `campaign-${String(centerFeetNorth)}-${String(radiusFeet)}`,
  targeting: { kind: 'geofence', center: feetNorth(centerFeetNorth), radiusFeet },
  collectsChd: false,
  chdConsentSource: null,
});

describe('NV SB 370 geofence ban (negative tests)', () => {
  it('blocks a geofence drawn around the facility', () => {
    const decision = evaluateCampaign(geofence(0, 500), [clinic]);
    expect(decision.allowed).toBe(false);
    expect(decision.blocks).toEqual([
      { rule: 'nv-sb370-geofence', facilityId: 'synthetic-clinic-lv', edgeDistanceFeet: 0 },
    ]);
    expect(decision.rulesetVersion).toBe(GEOFENCE_RULESET_V1.version);
  });

  it('blocks a geofence whose edge comes within the ban distance, even when centred far away', () => {
    const decision = evaluateCampaign(geofence(5_000, 3_500), [clinic]);
    expect(decision.allowed).toBe(false);
    const block = decision.blocks[0];
    expect(block?.rule).toBe('nv-sb370-geofence');
    if (block?.rule === 'nv-sb370-geofence') {
      expect(block.edgeDistanceFeet).toBeLessThanOrEqual(GEOFENCE_RULESET_V1.banFeet);
    }
  });

  it('allows a geofence whose edge stays outside the ban distance', () => {
    expect(evaluateCampaign(geofence(10_000, 1_000), [clinic]).allowed).toBe(true);
  });

  it('measures distance in feet', () => {
    expect(Math.round(distanceFeet(clinic.location, feetNorth(1_000)))).toBeGreaterThan(990);
    expect(Math.round(distanceFeet(clinic.location, feetNorth(1_000)))).toBeLessThan(1_010);
  });
});

describe('CHD collection needs an affirmative opt-in (R6-SR-020)', () => {
  const quiz = (source: CampaignPlan['chdConsentSource']): CampaignPlan => ({
    campaignId: 'quiz',
    targeting: { kind: 'list', audienceRef: 'synthetic-audience' },
    collectsChd: true,
    chdConsentSource: source,
  });

  it('blocks CHD collection without an opt-in or on a non-affirmative source', () => {
    expect(evaluateCampaign(quiz(null), []).blocks).toEqual([{ rule: 'chd-opt-in-required' }]);
    expect(evaluateCampaign(quiz('api_import'), []).allowed).toBe(false);
    expect(evaluateCampaign(quiz('double_optin'), []).allowed).toBe(true);
  });
});
