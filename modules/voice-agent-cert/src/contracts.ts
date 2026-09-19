export const CERT_IDENTITY = 'WP-103/VOICE-AGENT-CERT';

export type DrillName =
  'emergency-interrupt' | 'tool-calls' | 'consent' | 'kill-switch' | 'qa-completeness';

export class CertError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CertError';
  }
}

export interface DrillResult {
  readonly drill: DrillName;
  readonly passed: boolean;
  readonly detail: string;
}

export interface CertPackResult {
  readonly identity: typeof CERT_IDENTITY;
  readonly drills: readonly DrillResult[];
  readonly sampledDown: boolean;
  readonly allPassed: boolean;
}
