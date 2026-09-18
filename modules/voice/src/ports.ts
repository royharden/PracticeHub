export interface UrgencyScreenDouble {
  readonly doubleId: 'wp045-urgency-double/v1';
  screen(input: {
    readonly tenantId: string;
    readonly callId: string;
    readonly transcriptRef: string | null;
  }): {
    readonly urgency: 'routine' | 'urgent' | 'emergency';
    readonly workItemId: string;
  };
}

export interface OnCallContextDouble {
  readonly doubleId: 'wp023-oncall-double/v1';
  page(input: {
    readonly tenantId: string;
    readonly callId: string;
    readonly urgency: 'urgent' | 'emergency';
  }): {
    readonly contextPackageRef: string;
    readonly workItemId: string;
  };
}

export interface CommsThreadDouble {
  readonly doubleId: 'wp044-comms-double/v1';
  openVoiceShell(input: { readonly tenantId: string; readonly callId: string }): {
    readonly threadId: string;
  };
}

export interface LocationPolicyDouble {
  readonly doubleId: 'wp011-location-double/v1';
  recordingRule(input: { readonly tenantId: string; readonly jurisdiction: string }): {
    readonly rule: 'all-party';
    readonly counselReviewPending: boolean;
  };
}

export interface LegalHoldRegistryDouble {
  readonly doubleId: 'legal-hold-registry-double/v1';
  hasHold(callId: string): boolean;
}
