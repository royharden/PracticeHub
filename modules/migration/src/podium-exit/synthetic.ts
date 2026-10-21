/** Synthetic WP-115 test material. Fiction-range numbers only (555-01xx). */

import type { SendAuthorityEvent } from './send-authority.js';
import type {
  BusinessNumber,
  LetterOfAuthorization,
  NumberServiceProfile,
  OwnerOfRecordEvidence,
  PortCapabilityGrant,
} from './types.js';

export const tenant = 'northwind-synthetic';
export const otherTenant = 'riverbend-synthetic';
export const wave = 'wave-nv-01';
export const numberA = '+17025550101';
export const numberB = '+17025550102';

export const inventory: readonly BusinessNumber[] = [
  { tenantId: tenant, numberRef: numberA, locationRef: 'loc-nv-henderson', synthetic: true },
  { tenantId: tenant, numberRef: numberB, locationRef: 'loc-nv-Demo District', synthetic: true },
];

export const evidence: readonly OwnerOfRecordEvidence[] = [numberA, numberB].map((numberRef) => ({
  numberRef,
  carrierAccountRef: 'carrier-acct-synthetic-1',
  authorizedSignerRef: 'signer-synthetic-ops',
  billingNameOnAccount: 'Northwind Synthetic Clinic LLC',
  evidenceRef: `owner-evidence:${numberRef}`,
}));

export const profile = (numberRef: string): NumberServiceProfile => ({
  numberRef,
  e911AddressRef: `e911:${numberRef}`,
  tenDlcCampaignRef: 'tcr-campaign-synthetic-1',
  inboundRouteRef: `route:${numberRef}`,
  voicemailRef: `vm:${numberRef}`,
  forwardingFallbackRef: `fwd:${numberRef}`,
});

export const loa: LetterOfAuthorization = {
  loaRef: 'loa-synthetic-1',
  tenantId: tenant,
  numberRefs: [numberA, numberB],
  carrierAccountRef: 'carrier-acct-synthetic-1',
  signerRef: 'signer-synthetic-ops',
  billingName: 'Northwind Synthetic Clinic LLC',
  signedAt: '2026-01-05T15:00:00Z',
  synthetic: true,
};

export const baseline = (numberRef: string): SendAuthorityEvent => ({
  eventId: `auth:${numberRef}:1`,
  tenantId: tenant,
  numberRef,
  seq: 1,
  kind: 'baseline',
  fromHolder: 'none',
  toHolder: 'podium',
  podium: 'send-capable',
  northwind: 'read-only',
  carrierRoutingRef: 'routing:podium-carrier',
  tenDlcCampaignRef: 'tcr-campaign-synthetic-1',
  consentSourceRef: 'consent:podium',
  inboundRouteRef: `route:${numberRef}`,
  effectiveAt: '2026-01-01T00:00:00Z',
  synthetic: true,
});

export const cutover = (numberRef: string): SendAuthorityEvent => ({
  eventId: `auth:${numberRef}:2`,
  tenantId: tenant,
  numberRef,
  seq: 2,
  kind: 'cutover',
  fromHolder: 'podium',
  toHolder: 'northwind',
  podium: 'read-only',
  northwind: 'send-capable',
  carrierRoutingRef: 'routing:twilio-sim',
  tenDlcCampaignRef: 'tcr-campaign-synthetic-1',
  consentSourceRef: 'consent:northwind-ledger',
  inboundRouteRef: `route:${numberRef}`,
  effectiveAt: '2026-02-01T12:00:00Z',
  synthetic: true,
});

export const grant = (
  capabilityId: string,
  state: PortCapabilityGrant['state'],
  scope: PortCapabilityGrant['scope'] = {},
  tenantId = tenant,
): PortCapabilityGrant => ({ tenantId, capabilityId, state, scope });

export const readyGrants = (numberRefs: readonly string[]): readonly PortCapabilityGrant[] => [
  grant('consent.operational', 'simulated'),
  ...numberRefs.map((numberRef) =>
    grant('migration.podium-port', 'simulated', { number: numberRef, wave }),
  ),
];
