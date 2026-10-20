/**
 * WP-115 Podium exit (M27;M11): shared value types.
 *
 * Everything here is synthetic and simulated. The real telecom and Podium
 * surfaces are external waits (EW-TEL-01, EW-TEL-02, EW-PODIUM-01); this
 * package runs only against twilio-sim-shaped structural ports.
 */

export type SendSystem = 'podium' | 'northwind';

/** Who may originate SMS for one number. `none` is the fail-closed state. */
export type SendHolder = SendSystem | 'none';

export interface BusinessNumber {
  readonly tenantId: string;
  /** Synthetic E.164 number from the 555-01xx fiction range. */
  readonly numberRef: string;
  readonly locationRef: string;
  readonly synthetic: true;
}

export interface OwnerOfRecordEvidence {
  readonly numberRef: string;
  readonly carrierAccountRef: string;
  readonly authorizedSignerRef: string;
  readonly billingNameOnAccount: string;
  readonly evidenceRef: string;
}

export interface LetterOfAuthorization {
  readonly loaRef: string;
  readonly tenantId: string;
  readonly numberRefs: readonly string[];
  readonly carrierAccountRef: string;
  readonly signerRef: string;
  readonly billingName: string;
  readonly signedAt: string | null;
  readonly synthetic: true;
}

export interface NumberServiceProfile {
  readonly numberRef: string;
  readonly e911AddressRef: string | null;
  readonly tenDlcCampaignRef: string | null;
  readonly inboundRouteRef: string | null;
  readonly voicemailRef: string | null;
  readonly forwardingFallbackRef: string | null;
}

export interface PortCapabilityGrant {
  readonly tenantId: string;
  readonly capabilityId: string;
  readonly state:
    | 'disabled'
    | 'scaffolded'
    | 'simulated'
    | 'shadow'
    | 'pilot'
    | 'active'
    | 'read-only'
    | 'retiring';
  /** Capability-registry scope; `migration.podium-port` is scoped by number and wave. */
  readonly scope: Readonly<{ number?: string; wave?: string }>;
}
