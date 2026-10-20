/**
 * NV SB 370 geofence ban and CHD opt-in gate for campaigns (R6-SR-022,
 * R6-SR-020, REQ-PORT-001 AC3). A campaign whose geofence comes within the ban
 * distance of any healthcare facility is blocked, and so is a campaign that
 * collects consumer health data without an affirmative opt-in. The decision
 * names the rule, the facility and the ruleset version it applied.
 */

import { affirmativeConsentSources, type ConsentSource } from '../consent.js';

export interface GeofenceRuleset {
  readonly version: string;
  /** Counsel-confirmed ban radius around a healthcare facility, in feet. */
  readonly banFeet: number;
}

export const GEOFENCE_RULESET_V1: GeofenceRuleset = {
  version: 'nv-sb370-geofence/v1',
  banFeet: 1_750,
};

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface HealthcareFacility {
  readonly facilityId: string;
  readonly location: GeoPoint;
}

export type CampaignTargeting =
  | { readonly kind: 'geofence'; readonly center: GeoPoint; readonly radiusFeet: number }
  | { readonly kind: 'list'; readonly audienceRef: string }
  | { readonly kind: 'none' };

export interface CampaignPlan {
  readonly campaignId: string;
  readonly targeting: CampaignTargeting;
  readonly collectsChd: boolean;
  /** The consent source the campaign relies on for CHD collection, if any. */
  readonly chdConsentSource: ConsentSource | null;
}

export type CampaignBlock =
  | {
      readonly rule: 'nv-sb370-geofence';
      readonly facilityId: string;
      readonly edgeDistanceFeet: number;
    }
  | { readonly rule: 'chd-opt-in-required' };

export interface CampaignDecision {
  readonly campaignId: string;
  readonly allowed: boolean;
  readonly blocks: readonly CampaignBlock[];
  readonly rulesetVersion: string;
}

const EARTH_RADIUS_FEET = 20_902_231;

/** Great-circle distance in feet (haversine). */
export function distanceFeet(from: GeoPoint, to: GeoPoint): number {
  const radians = (degrees: number): number => (degrees * Math.PI) / 180;
  const dLat = radians(to.lat - from.lat);
  const dLon = radians(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_FEET * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function evaluateCampaign(
  plan: CampaignPlan,
  facilities: readonly HealthcareFacility[],
  ruleset: GeofenceRuleset = GEOFENCE_RULESET_V1,
): CampaignDecision {
  const blocks: CampaignBlock[] = [];
  if (plan.targeting.kind === 'geofence') {
    const { center, radiusFeet } = plan.targeting;
    for (const facility of facilities) {
      const edgeDistanceFeet = Math.max(0, distanceFeet(center, facility.location) - radiusFeet);
      if (edgeDistanceFeet <= ruleset.banFeet) {
        blocks.push({
          rule: 'nv-sb370-geofence',
          facilityId: facility.facilityId,
          edgeDistanceFeet: Math.round(edgeDistanceFeet),
        });
      }
    }
  }
  if (
    plan.collectsChd &&
    (plan.chdConsentSource === null || !affirmativeConsentSources.includes(plan.chdConsentSource))
  ) {
    blocks.push({ rule: 'chd-opt-in-required' });
  }
  return {
    campaignId: plan.campaignId,
    allowed: blocks.length === 0,
    blocks,
    rulesetVersion: ruleset.version,
  };
}
