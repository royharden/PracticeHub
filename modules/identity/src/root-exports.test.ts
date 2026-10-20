import { describe, expect, expectTypeOf, it } from 'vitest';

import * as root from './index.js';
import * as leaf0 from './portal-ato/index.js';

/** Regression: accepted leaf APIs must be usable from the module root; no replacement doubles. */
describe('identity public root integration', () => {
  it('retains an existing public entry point', () => {
    expect(root.assertIdentityId).toBeDefined();
  });

  it('exports the pinned runtime API with the original implementations', () => {
    expect(root.accountSignals).toBe(leaf0.accountSignals);
    expect(root.auditPaperKit).toBe(leaf0.auditPaperKit);
    expect(root.ConsentFallbackError).toBe(leaf0.ConsentFallbackError);
    expect(root.CREDENTIAL_STUFFING_DRILL).toBe(leaf0.CREDENTIAL_STUFFING_DRILL);
    expect(root.decideVisit).toBe(leaf0.decideVisit);
    expect(root.detectStuffingWaves).toBe(leaf0.detectStuffingWaves);
    expect(root.digitizationWorklist).toBe(leaf0.digitizationWorklist);
    expect(root.digitizeScan).toBe(leaf0.digitizeScan);
    expect(root.IMPOSSIBLE_TRAVEL_DRILL).toBe(leaf0.IMPOSSIBLE_TRAVEL_DRILL);
    expect(root.InMemoryConsentFormCatalog).toBe(leaf0.InMemoryConsentFormCatalog);
    expect(root.InMemoryPaperConsentLedger).toBe(leaf0.InMemoryPaperConsentLedger);
    expect(root.InMemoryVisitConsentMatrix).toBe(leaf0.InMemoryVisitConsentMatrix);
    expect(root.pendingDigitizations).toBe(leaf0.pendingDigitizations);
    expect(root.planCheckInConsents).toBe(leaf0.planCheckInConsents);
    expect(root.PortalAtoError).toBe(leaf0.PortalAtoError);
    expect(root.recordPaperCapture).toBe(leaf0.recordPaperCapture);
    expect(root.reportEsignOutage).toBe(leaf0.reportEsignOutage);
    expect(root.restorePortalAccess).toBe(leaf0.restorePortalAccess);
    expect(root.resumeAfterRecovery).toBe(leaf0.resumeAfterRecovery);
    expect(root.runAtoDrill).toBe(leaf0.runAtoDrill);
    expect(root.runPortalAtoChain).toBe(leaf0.runPortalAtoChain);
    expect(root.startCheckInConsent).toBe(leaf0.startCheckInConsent);
    expect(root.stuffingWaveThresholdsV1).toBe(leaf0.stuffingWaveThresholdsV1);
  });

  it('preserves representative public type contracts', () => {
    expectTypeOf<root.AccountAtoOutcome>().toEqualTypeOf<leaf0.AccountAtoOutcome>();
  });

  it('exposes portal ATO detection through the root', () => {
    expect(root.detectStuffingWaves([])).toEqual([]);
    expect(() => root.assertIdentityId('INVALID ID', 'synthetic')).toThrow();
  });
});
