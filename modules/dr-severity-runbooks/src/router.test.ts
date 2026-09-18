import { describe, expect, it } from 'vitest';

import { SeverityRouter } from './router.js';
import { Wp023OnCallDoubleV1 } from './testing/wp023-oncall-double-v1.js';
import { Wp120PagerDoubleV1 } from './testing/wp120-pager-double-v1.js';
import { SeverityRouterError } from './types.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

const incident = {
  tenantId: northwind,
  incidentId: 'inc-1',
  severity: 'sev1' as const,
  runbookRef: 'runbook-db-outage',
  occurredAt: '2026-09-18T00:00:00.000Z',
};

const make = (): {
  router: SeverityRouter;
  onCall: Wp023OnCallDoubleV1;
  pager: Wp120PagerDoubleV1;
} => {
  const onCall = new Wp023OnCallDoubleV1();
  const pager = new Wp120PagerDoubleV1();
  onCall.setPrimary(northwind, 'sre-opaque-1');
  return { router: new SeverityRouter(onCall, pager), onCall, pager };
};

describe('SeverityRouter', () => {
  it('pages sev1 through the on-call primary', () => {
    const { router, pager } = make();
    const decision = router.route(incident);
    expect(decision.channels).toEqual(['pager', 'in-app', 'runbook']);
    expect(decision.onCallMemberRef).toBe('sre-opaque-1');
    expect(decision.pagerDelivered).toBe(true);
    expect(decision.pagingIndependent).toBe(false);
    expect(pager.snapshot()).toHaveLength(1);
  });

  it('keeps sev1 routing when the pager vendor is down (paging independence)', () => {
    const { router, pager } = make();
    pager.vendorDown = true;
    const decision = router.route(incident);
    expect(decision.channels).toContain('in-app');
    expect(decision.channels).toContain('runbook');
    expect(decision.pagerDelivered).toBe(false);
    expect(decision.pagingIndependent).toBe(true);
  });

  it('routes sev3 to ticket without paging', () => {
    const { router, pager } = make();
    const decision = router.route({ ...incident, severity: 'sev3', incidentId: 'inc-3' });
    expect(decision.channels).toEqual(['ticket', 'in-app', 'runbook']);
    expect(decision.pagerDelivered).toBe(false);
    expect(pager.snapshot()).toEqual([]);
  });

  it('does not page sev4', () => {
    const { router, pager } = make();
    const decision = router.route({ ...incident, severity: 'sev4', incidentId: 'inc-4' });
    expect(decision.channels).toEqual(['runbook']);
    expect(decision.pagerDelivered).toBe(false);
    expect(pager.snapshot()).toEqual([]);
  });

  it('refuses sev1 without on-call coverage instead of dropping the incident', () => {
    const onCall = new Wp023OnCallDoubleV1();
    const pager = new Wp120PagerDoubleV1();
    const router = new SeverityRouter(onCall, pager);
    expect(() => router.route(incident)).toThrow(SeverityRouterError);
    expect(pager.snapshot()).toEqual([]);
  });

  it('isolates tenants that share incident ids', () => {
    const { router, onCall } = make();
    onCall.setPrimary(riverbend, 'sre-opaque-2');
    const nw = router.route(incident);
    const rb = router.route({ ...incident, tenantId: riverbend });
    expect(nw.onCallMemberRef).toBe('sre-opaque-1');
    expect(rb.onCallMemberRef).toBe('sre-opaque-2');
  });
});
