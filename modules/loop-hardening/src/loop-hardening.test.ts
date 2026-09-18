import { describe, expect, it } from 'vitest';

import {
  assertStableApplicationKey,
  runLoopHardeningExecution,
  runLoopHardeningHappyPath,
  stableApplicationKey,
} from './harness.js';
import { executionManifest, loopIds, loopManifest } from './manifest.js';
import {
  runClinicalSubjectFenceProbe,
  runClinicalVersionDriftProbe,
} from './bindings/clinical-loop-v1.js';
import { runCommsConsentDenialProbe } from './bindings/comms-loop.js';
import { runPaidTenantFenceProbe } from './bindings/paid-service-loop.js';
import { assertReqPlat018DispositionsComplete } from './acex-dispositions.js';

describe('WP-033 loop-hardening execution matrix', () => {
  it('declares exactly 18 concrete executions over three loops and four primitives', () => {
    expect(executionManifest).toHaveLength(18);
    expect(new Set(executionManifest.map((entry) => entry.executionId)).size).toBe(18);
    expect(new Set(executionManifest.map((entry) => entry.loopId)).size).toBe(3);
    expect(new Set(executionManifest.map((entry) => entry.primitiveId))).toEqual(
      new Set(['X-02', 'X-03', 'X-04', 'X-07']),
    );
  });

  it.each(executionManifest)('$executionId', async (execution) => {
    const result = await runLoopHardeningExecution(execution.executionId);
    const paidBeforeEffect =
      execution.loopId === '4B-paid-service-v1' && execution.killPoint === 'before-effect';
    expect(result.synthetic).toBe(true);
    expect(result.effects).toHaveLength(paidBeforeEffect ? 0 : 1);
    expect(result.effects.every((effect) => effect.synthetic)).toBe(true);
    expect(result.railResponses.every((response) => !response.resendsExternalEffect)).toBe(true);
    expect(result.product.transitionCount).toBeLessThanOrEqual(1);
    expect(result.product.terminalRegression).toBe(false);
    expect(result.product.correlationExact).toBe(true);
    expect(
      result.product.evidenceRefs.length > 0 || result.product.ownedException !== undefined,
    ).toBe(true);
    expect(result.heartbeat.alarmed).toBe(true);
    expect(result.heartbeat.deadMonitorReasons).toContain('reconciliation-did-not-run');
    expect(result.invariants.map((entry) => entry.invariantId)).toEqual([
      'I-A',
      'I-B',
      'I-C',
      'I-D',
      'I-E',
      'I-F',
      'I-G',
      'I-H',
      'I-I',
    ]);
    expect(result.invariants.every((entry) => entry.passed)).toBe(true);
    expect(result.killedAt).toBe(execution.killPoint ?? null);
    expect(loopManifest[execution.loopId].railId).toMatch(/^RAIL-\d{3}$/);
  });

  it.each(executionManifest.filter((entry) => entry.primitiveId === 'X-03'))(
    '$executionId proves simulator-owned replay without a harness replay crutch',
    async (execution) => {
      const result = await runLoopHardeningExecution(execution.executionId);
      expect(result.effects[0]?.attempts).toBe(2);
      expect(result.receipts.map((receipt) => receipt.kind)).toEqual(['primary']);
    },
  );

  it.each(executionManifest.filter((entry) => entry.primitiveId === 'X-04'))(
    '$executionId proves duplicate receipt shape',
    async (execution) => {
      const result = await runLoopHardeningExecution(execution.executionId);
      expect(result.receipts.map((receipt) => receipt.kind)).toEqual(['primary', 'duplicate']);
    },
  );

  it.each(executionManifest.filter((entry) => entry.primitiveId === 'X-07'))(
    '$executionId proves reversed receipt drain order',
    async (execution) => {
      const result = await runLoopHardeningExecution(execution.executionId);
      expect(result.receipts.map((receipt) => receipt.sequence)).toEqual([2, 1]);
    },
  );

  it('I-C fails closed before the communications rail and still audits the denial', async () => {
    await expect(runCommsConsentDenialProbe()).resolves.toEqual({
      railEffects: 0,
      audited: true,
    });
  });

  it.each([...loopIds])(
    '%s first-attempt happy path lands one synthetic effect',
    async (loopId) => {
      const result = await runLoopHardeningHappyPath(loopId);
      expect(result.killedAt).toBeNull();
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0]?.state).toBe('landed');
      expect(result.product.transitionCount).toBe(1);
      expect(result.product.evidenceRefs.length).toBeGreaterThan(0);
    },
  );

  it('REQ-PLAT-018 AC/EX clauses are all disposed', () => {
    expect(() => assertReqPlat018DispositionsComplete()).not.toThrow();
  });

  it('4C subject mismatch is rejected', async () => {
    await expect(runClinicalSubjectFenceProbe()).resolves.toEqual({ rejected: true });
  });

  it('4B foreign-tenant reconcile is rejected', async () => {
    await expect(runPaidTenantFenceProbe()).resolves.toEqual({ rejected: true });
  });

  it('4C source-version drift is held and does not reconcile signed truth', async () => {
    await expect(runClinicalVersionDriftProbe()).resolves.toEqual({
      state: 'accepted',
      held: true,
      reason: 'CLINICAL_VERSION_DRIFT',
      transitionCount: 0,
    });
  });

  it('negative mutation: a primitive-suffixed key cannot evade the stable application fence', () => {
    const identity = {
      loopId: '4A-comms-v1',
      tenantId: 'northwind-synthetic',
      logicalItemId: 'wp033-item-1',
      operation: 'send-message',
    } as const;
    const stable = stableApplicationKey(identity);
    expect(() => assertStableApplicationKey(`${stable}:x-04`, identity)).toThrow(
      'WP033_STABLE_KEY_GUARD',
    );
    expect(() => assertStableApplicationKey(stable, identity)).not.toThrow();
  });
});
