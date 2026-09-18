export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4';

export type Channel = 'pager' | 'in-app' | 'runbook' | 'ticket';

export interface Incident {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly severity: Severity;
  readonly runbookRef: string;
  readonly occurredAt: string;
}

export interface RouteDecision {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly severity: Severity;
  readonly channels: readonly Channel[];
  readonly onCallMemberRef: string | null;
  readonly pagerDelivered: boolean;
  readonly pagingIndependent: boolean;
}

export interface OnCallRosterPort {
  primary(tenantId: string): string | null;
}

export interface PagerPort {
  page(input: {
    readonly tenantId: string;
    readonly memberRef: string;
    readonly incidentId: string;
  }): 'delivered' | 'vendor_down';
}

export class SeverityRouterError extends Error {
  public constructor(public readonly code: 'UNKNOWN_SEVERITY' | 'NO_COVERAGE') {
    super(code);
    this.name = 'SeverityRouterError';
  }
}
