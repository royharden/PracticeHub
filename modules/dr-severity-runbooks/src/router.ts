import type {
  Channel,
  Incident,
  OnCallRosterPort,
  PagerPort,
  RouteDecision,
  Severity,
} from './types.js';
import { SeverityRouterError } from './types.js';

const channelsBySeverity: Record<Severity, readonly Channel[]> = {
  sev1: ['pager', 'in-app', 'runbook'],
  sev2: ['pager', 'in-app', 'runbook'],
  sev3: ['ticket', 'in-app', 'runbook'],
  sev4: ['runbook'],
};

export class SeverityRouter {
  public constructor(
    private readonly onCall: OnCallRosterPort,
    private readonly pager: PagerPort,
  ) {}

  public route(incident: Incident): RouteDecision {
    const channels = channelsBySeverity[incident.severity];
    if (channels === undefined) throw new SeverityRouterError('UNKNOWN_SEVERITY');
    const needsPage = channels.includes('pager');
    const onCallMemberRef = this.onCall.primary(incident.tenantId);
    if (needsPage && onCallMemberRef === null) {
      throw new SeverityRouterError('NO_COVERAGE');
    }
    let pagerDelivered = false;
    let pagingIndependent = false;
    if (needsPage && onCallMemberRef !== null) {
      const result = this.pager.page({
        tenantId: incident.tenantId,
        memberRef: onCallMemberRef,
        incidentId: incident.incidentId,
      });
      pagerDelivered = result === 'delivered';
      pagingIndependent = result === 'vendor_down';
    }
    return {
      tenantId: incident.tenantId,
      incidentId: incident.incidentId,
      severity: incident.severity,
      channels,
      onCallMemberRef,
      pagerDelivered,
      pagingIndependent,
    };
  }
}
