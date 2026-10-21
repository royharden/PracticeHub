import { describe, expect, expectTypeOf, it } from 'vitest';

import * as root from './index.js';
import * as leaf0 from './triage-eval/index.js';

/** Regression: accepted leaf APIs must be usable from the module root; no replacement doubles. */
describe('urgency-screen public root integration', () => {
  it('retains an existing public entry point', () => {
    expect(root.screenInbound).toBeDefined();
  });

  it('exports the pinned runtime API with the original implementations', () => {
    expect(root.addConfirmedMiss).toBe(leaf0.addConfirmedMiss);
    expect(root.BASELINE_CATCH_LIST_V1).toBe(leaf0.BASELINE_CATCH_LIST_V1);
    expect(root.catchListDigest).toBe(leaf0.catchListDigest);
    expect(root.catchListKey).toBe(leaf0.catchListKey);
    expect(root.catchListLabels).toBe(leaf0.catchListLabels);
    expect(root.catchListReasons).toBe(leaf0.catchListReasons);
    expect(root.classifyForEval).toBe(leaf0.classifyForEval);
    expect(root.createGoldenSet).toBe(leaf0.createGoldenSet);
    expect(root.directionOf).toBe(leaf0.directionOf);
    expect(root.EVAL_TENANT_ID).toBe(leaf0.EVAL_TENANT_ID);
    expect(root.evaluateCatchList).toBe(leaf0.evaluateCatchList);
    expect(root.evaluateClassifier).toBe(leaf0.evaluateClassifier);
    expect(root.factBreaches).toBe(leaf0.factBreaches);
    expect(root.faultKey).toBe(leaf0.faultKey);
    expect(root.faultRegressions).toBe(leaf0.faultRegressions);
    expect(root.FAULTS).toBe(leaf0.FAULTS);
    expect(root.GOLDEN_SET_SERIES).toBe(leaf0.GOLDEN_SET_SERIES);
    expect(root.GOLDEN_SET_V1).toBe(leaf0.GOLDEN_SET_V1);
    expect(root.GOLDEN_SET_V2).toBe(leaf0.GOLDEN_SET_V2);
    expect(root.GOLDEN_SET_V2_PROVENANCE).toBe(leaf0.GOLDEN_SET_V2_PROVENANCE);
    expect(root.goldenSetDigest).toBe(leaf0.goldenSetDigest);
    expect(root.inputForCase).toBe(leaf0.inputForCase);
    expect(root.isSafe).toBe(leaf0.isSafe);
    expect(root.LANDED_URGENCY_SCREEN).toBe(leaf0.LANDED_URGENCY_SCREEN);
    expect(root.MATRIX_LANGUAGES).toBe(leaf0.MATRIX_LANGUAGES);
    expect(root.reviewClassifierChange).toBe(leaf0.reviewClassifierChange);
    expect(root.RIGHT_SINGLE_QUOTE).toBe(leaf0.RIGHT_SINGLE_QUOTE);
    expect(root.runFailureDirectionSuite).toBe(leaf0.runFailureDirectionSuite);
    expect(root.sha256Json).toBe(leaf0.sha256Json);
    expect(root.TRIAGE_EVAL_VERSION).toBe(leaf0.TRIAGE_EVAL_VERSION);
    expect(root.urgentRegressions).toBe(leaf0.urgentRegressions);
    expect(root.WP101_EVAL_HARNESS_PLACEHOLDER_ID).toBe(leaf0.WP101_EVAL_HARNESS_PLACEHOLDER_ID);
    expect(root.Wp101EvalHarnessPlaceholder).toBe(leaf0.Wp101EvalHarnessPlaceholder);
  });

  it('preserves representative public type contracts', () => {
    expectTypeOf<root.CaseOutcome>().toEqualTypeOf<leaf0.CaseOutcome>();
  });

  it('exposes catch-list digest without implying promotion approval', () => {
    const list = root.BASELINE_CATCH_LIST_V1;
    const digest = root.catchListDigest(list);
    expect(list.length).toBeGreaterThan(1);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(root.catchListDigest(list.slice(1))).not.toBe(digest);
  });
});
