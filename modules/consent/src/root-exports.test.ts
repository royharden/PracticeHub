import { describe, expect, expectTypeOf, it } from 'vitest';

import * as root from './index.js';
import * as leaf0 from './consumer-rights/index.js';

/** Regression: accepted leaf APIs must be usable from the module root; no replacement doubles. */
describe('consent public root integration', () => {
  it('retains an existing public entry point', () => {
    expect(root.consentChannels).toBeDefined();
  });

  it('exports the pinned runtime API with the original implementations', () => {
    expect(root.actOnChdRequest).toBe(leaf0.actOnChdRequest);
    expect(root.appealChdDecision).toBe(leaf0.appealChdDecision);
    expect(root.approveTermination).toBe(leaf0.approveTermination);
    expect(root.assignChecklistItem).toBe(leaf0.assignChecklistItem);
    expect(root.buildContinuityChecklist).toBe(leaf0.buildContinuityChecklist);
    expect(root.cancelFlowViolations).toBe(leaf0.cancelFlowViolations);
    expect(root.cancelMembership).toBe(leaf0.cancelMembership);
    expect(root.CHD_RULESET_V1).toBe(leaf0.CHD_RULESET_V1);
    expect(root.chdMarketingAllowed).toBe(leaf0.chdMarketingAllowed);
    expect(root.chdSaleAllowed).toBe(leaf0.chdSaleAllowed);
    expect(root.closeTermination).toBe(leaf0.closeTermination);
    expect(root.ConsumerRightsError).toBe(leaf0.ConsumerRightsError);
    expect(root.DAY_MS).toBe(leaf0.DAY_MS);
    expect(root.daysFrom).toBe(leaf0.daysFrom);
    expect(root.decideChdAppeal).toBe(leaf0.decideChdAppeal);
    expect(root.DISCRIMINATION_BLOCKER).toBe(leaf0.DISCRIMINATION_BLOCKER);
    expect(root.distanceFeet).toBe(leaf0.distanceFeet);
    expect(root.entitledOn).toBe(leaf0.entitledOn);
    expect(root.evaluateCampaign).toBe(leaf0.evaluateCampaign);
    expect(root.extendChdDeadline).toBe(leaf0.extendChdDeadline);
    expect(root.GEOFENCE_RULESET_V1).toBe(leaf0.GEOFENCE_RULESET_V1);
    expect(root.parseRenewalRules).toBe(leaf0.parseRenewalRules);
    expect(root.placeholderEncounters).toBe(leaf0.placeholderEncounters);
    expect(root.placeholderIdentity).toBe(leaf0.placeholderIdentity);
    expect(root.placeholderMembership).toBe(leaf0.placeholderMembership);
    expect(root.plusDays).toBe(leaf0.plusDays);
    expect(root.proposeTermination).toBe(leaf0.proposeTermination);
    expect(root.recordNotice).toBe(leaf0.recordNotice);
    expect(root.recordUrgentRiskDisposition).toBe(leaf0.recordUrgentRiskDisposition);
    expect(root.RENEWAL_RULES_V1).toBe(leaf0.RENEWAL_RULES_V1);
    expect(root.renewalNotice).toBe(leaf0.renewalNotice);
    expect(root.resolveChecklistItem).toBe(leaf0.resolveChecklistItem);
    expect(root.resolveRenewalPolicy).toBe(leaf0.resolveRenewalPolicy);
    expect(root.reverseTermination).toBe(leaf0.reverseTermination);
    expect(root.reviewEscalation).toBe(leaf0.reviewEscalation);
    expect(root.shouldAutoRenew).toBe(leaf0.shouldAutoRenew);
    expect(root.submitChdRequest).toBe(leaf0.submitChdRequest);
    expect(root.TERMINATION_RULESET_V1).toBe(leaf0.TERMINATION_RULESET_V1);
    expect(root.terminationBlockers).toBe(leaf0.terminationBlockers);
    expect(root.verifyChdRequester).toBe(leaf0.verifyChdRequester);
  });

  it('preserves representative public type contracts', () => {
    expectTypeOf<root.CampaignBlock>().toEqualTypeOf<leaf0.CampaignBlock>();
  });

  it('keeps CHD collection fail-closed through the root API', () => {
    const decision = root.evaluateCampaign(
      {
        campaignId: 'synthetic-root-export',
        targeting: { kind: 'none' },
        collectsChd: true,
        chdConsentSource: null,
      },
      [],
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blocks).toContainEqual({ rule: 'chd-opt-in-required' });
  });
});
