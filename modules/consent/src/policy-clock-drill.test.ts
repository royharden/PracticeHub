/**
 * R6-SR-102 statute-tracker config RE-DERIVATION DRILL (WP-019, review-016 F5).
 *
 * The rule-pack-review obligation clock is the statute tracker: on escalate it
 * surfaces the rule-pack-review WorkItem directing counsel to re-derive statutes
 * and bump the WP-011 jurisdiction rule packs. This drill exercises the WHOLE
 * loop end-to-end and TRACES it through the real WP-011 resolver — the clock is
 * not closed until an actual rule-pack version bump has flowed through the
 * jurisdiction truth-table/regression gate:
 *
 *   trigger → escalate → rule-pack-review WorkItem → counsel re-derives (a new
 *   effective-dated NV rule-pack version) → the WP-011 resolver reflects the bump
 *   ONLY on/after its effective date (the regression gate) → the clock closes
 *   with STRUCTURED evidence: the change-control ref + the truth-table
 *   regeneration receipt (an arbitrary evidence ref no longer satisfies it).
 */
import { emitAuditEvent, emptyChainState } from '@practicehub/audit-evidence';
import {
  jurisdictionPacksV1,
  packBaselineEffectiveOn,
  resolveJurisdiction,
  type JurisdictionRulePack,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  escalateClock,
  recordClockSatisfaction,
  rulePackReviewWorkItem,
  triggerClock,
} from './clocks.js';
import { obligationClockPoliciesV1 } from './policy-clock-seed.js';

const tenant = 'northwind-synthetic';
const basis = { providerState: 'NV', patientState: 'NV' };

describe('R6-SR-102 config re-derivation drill (review-016 F5)', () => {
  it('a statute-tracker cycle re-derives an NV rule-pack version and closes with a truth-table receipt', () => {
    // 1. The statute-tracker clock triggers and escalates — its worklist opens.
    const tracker = triggerClock({
      tenantId: tenant,
      clockId: 'clk-drill-tracker',
      clockEventId: 'cle-drill-1',
      obligationType: 'rule-pack-review',
      subjectRef: 'rule-pack-scope:all-jurisdictions',
      triggerRef: 'statute-tracker:drill-cycle-0001',
      triggeredAt: '2026-01-01T00:00:00.000Z',
      actorRef: 'synthetic-platform-clock',
      basis: { providerState: null, patientState: null },
      policies: obligationClockPoliciesV1,
    });
    const escalated = escalateClock(tracker.instance, {
      clockEventId: 'cle-drill-2',
      occurredAt: tracker.instance.escalateAt,
      actorRef: 'synthetic-platform-clock',
    });
    const workItem = rulePackReviewWorkItem(escalated.instance, tracker.instance.escalateAt);
    expect(workItem.status).toBe('escalated');
    expect(workItem.directive).toMatch(/re-derive statutes and bump/);
    expect(workItem.rulePackScopeRef).toBe('rule-pack-scope:all-jurisdictions');

    // 2. Counsel re-derives: the resolver's CURRENT NV retention position.
    const baseline = resolveJurisdiction(
      jurisdictionPacksV1,
      basis,
      'retention',
      packBaselineEffectiveOn,
    );
    const baselineRetention = baseline.scalars['retention-years-adult'];
    expect(typeof baselineRetention).toBe('number');

    // The re-derivation extends NV's adult retention clock — a NEW, later
    // effective-dated rule-pack version (never a rewrite of the effective one).
    const nvV1 = jurisdictionPacksV1.find(
      (pack) => pack.jurisdiction === 'NV' && pack.version === 1,
    );
    expect(nvV1).toBeDefined();
    const bumpedRetention = (baselineRetention as number) + 100;
    const nvV2: JurisdictionRulePack = {
      ...(nvV1 as JurisdictionRulePack),
      version: 2,
      effectiveOn: '2027-01-01',
      changeControlRef: 'ccr-statute-2026-q1',
      rules: (nvV1 as JurisdictionRulePack).rules.map((rule) =>
        rule.topic === 'retention'
          ? {
              ...rule,
              scalars: { ...(rule.scalars ?? {}), 'retention-years-adult': bumpedRetention },
            }
          : rule,
      ),
    };
    const bumpedPacks = [...jurisdictionPacksV1, nvV2];

    // 3. The WP-011 resolver (the regression gate) reflects the bump ONLY on/after
    //    its effective date — pre-effective resolution is unchanged (behavior
    //    preserving), post-effective resolution carries the re-derived value.
    const preBump = resolveJurisdiction(bumpedPacks, basis, 'retention', '2026-12-31');
    expect(preBump.scalars['retention-years-adult']).toBe(baselineRetention);
    const afterBump = resolveJurisdiction(bumpedPacks, basis, 'retention', '2027-06-01');
    expect(afterBump.scalars['retention-years-adult']).toBe(bumpedRetention);

    // 4. Only now — with the version bump proven through the resolver — does the
    //    tracker close, carrying the change-control ref AND the truth-table
    //    regeneration receipt as STRUCTURED evidence.
    const truthTableReceiptRef = `truth-table:regen:nv-v2:retention-${bumpedRetention}`;
    const satisfied = recordClockSatisfaction(escalated.instance, {
      clockEventId: 'cle-drill-3',
      occurredAt: '2027-06-01T00:00:00.000Z',
      actorRef: 'synthetic-compliance-officer',
      closureEvidence: {
        changeControlRef: nvV2.changeControlRef,
        truthTableReceiptRef,
      },
    });
    expect(satisfied.instance.status).toBe('satisfied');
    expect(satisfied.instance.closureEvidenceRef).toBe('ccr-statute-2026-q1');
    expect(satisfied.event.changeControlRef).toBe('ccr-statute-2026-q1');
    expect(satisfied.event.truthTableReceiptRef).toBe(truthTableReceiptRef);

    // 5. The closure attestation emits through the REAL audit emitter (the
    //    R6-REQ-006/052 config-change evidence trail), carrying both refs.
    const emitted = emitAuditEvent(emptyChainState, {
      ...satisfied.auditInput,
      auditId: 'drill-clock-audit-0001',
    });
    expect(emitted.record.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(emitted.record.detail?.['truth_table_receipt']).toBe(truthTableReceiptRef);
    expect(emitted.record.detail?.['evidence_ref']).toBe('ccr-statute-2026-q1');
  });
});
