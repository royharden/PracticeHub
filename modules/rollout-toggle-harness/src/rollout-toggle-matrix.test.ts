import { describe, expect, it } from 'vitest';

import { Wp030LocalDouble } from './bindings/wp030-binding.js';
import { Wp031LocalDouble } from './bindings/wp031-binding.js';
import { Wp032CapabilityDoubleV1 } from './bindings/wp032-capability-double-v1.js';
import {
  HarnessError,
  TENANT_A,
  TENANT_B,
  WP032_DESCRIPTOR_SHA256,
  assertDescriptorHash,
  localHarnessRegistry,
  type TenantScopedClinicalProposal,
} from './contracts.js';
import { EffectRecorder, tenantCount } from './effect-recorder.js';
import {
  assertNotRealParity,
  createWorld,
  matrixRows,
  readinessReport,
  runMatrixRow,
} from './grant-matrix.js';

const packages = ['WP-030', 'WP-031', 'WP-032'] as const;

describe('WP-034 descriptor', () => {
  it('matches the frozen WP-032 descriptor hash', () => {
    assertDescriptorHash();
    expect(WP032_DESCRIPTOR_SHA256).toBe(
      'bf73e87c0ef1d4116a8b69f899d8c48f33a2a983665bf08b9530aa5039dfea96',
    );
  });
});

describe('grant matrix', () => {
  for (const workPackage of packages) {
    for (const row of matrixRows) {
      if (row === 'M12') continue;
      it(`${workPackage} ${row} ab`, async () => {
        const snapshot = await runMatrixRow(workPackage, row, 'ab');
        expect(snapshot.ordered.every((event) => event.synthetic === true)).toBe(true);
      });
      if (row === 'M1' || row === 'M2' || row === 'M5' || row === 'M9') {
        it(`${workPackage} ${row} ba`, async () => {
          await runMatrixRow(workPackage, row, 'ba');
        });
      }
    }
  }

  it('M12 rejects malformed state before invocation', async () => {
    await expect(runMatrixRow('WP-030', 'M12')).rejects.toMatchObject({
      code: 'MALFORMED_GRANT_STATE',
    });
  });
});

describe('readiness and probes', () => {
  it('rejects aggregate readiness while doubles remain', () => {
    expect(() =>
      readinessReport([
        { workPackage: 'WP-030', parity: 'versioned-double' },
        { workPackage: 'WP-031', parity: 'versioned-double' },
        { workPackage: 'WP-032', parity: 'versioned-double' },
      ]),
    ).toThrow(HarnessError);
  });

  it('rejects a self-declared real-consumer label on a double', () => {
    expect(() => assertNotRealParity('real-consumer')).toThrow(HarnessError);
    assertNotRealParity('versioned-double');
  });

  it('shared recorder key across tenants fails', () => {
    const recorder = new EffectRecorder();
    recorder.record({
      operationId: 'shared',
      effectId: 'e1',
      tenantId: TENANT_A,
      category: 'queuedIntent',
      checkpoint: 'enqueue',
      capabilityId: 'comms.accountable-message-loop',
      grantState: 'simulated',
      grantSnapshotVersion: 1,
      payload: {},
      synthetic: true,
    });
    expect(() => recorder.assertExclusiveKey(TENANT_B, 'shared')).toThrow(HarnessError);
  });

  it('unknown recorder category fails closed', () => {
    const recorder = new EffectRecorder();
    expect(() =>
      recorder.record({
        operationId: 'x',
        effectId: 'e',
        tenantId: TENANT_A,
        category: 'not-a-category' as never,
        checkpoint: 'enqueue',
        capabilityId: 'comms.accountable-message-loop',
        grantState: 'simulated',
        grantSnapshotVersion: 1,
        payload: {},
        synthetic: true,
      }),
    ).toThrow(HarnessError);
  });
});

describe('WP-032 identity contract', () => {
  it('foreign opaque effect identity fails before ack', async () => {
    const recorder = new EffectRecorder();
    const double = new Wp032CapabilityDoubleV1(recorder);
    const registry = localHarnessRegistry();
    const world = createWorld('WP-032');
    await runMatrixRow('WP-032', 'M2');
    const proposal: TenantScopedClinicalProposal = {
      requestKey: 'k1',
      tenantId: TENANT_A,
      subjectRef: 's',
      proposalRef: 'p',
      expectedSourceVersion: 'v1',
      payloadHash: 'h',
      synthetic: true,
    };
    const grants = world.registry.definitions.length > 0 ? [] : [];
    expect(() =>
      double.reconcileAcknowledgement(
        {
          tenantId: TENANT_B,
          requestKey: 'k1',
          effectId: 'foreign',
          receiptId: 'r1',
          outcome: 'unknown',
          synthetic: true,
        },
        {
          registry,
          grants,
          grantSnapshotVersion: 1,
          context: { tenantId: TENANT_B, scope: {} },
          checkpoint: 'drain',
        },
      ),
    ).toThrow(HarnessError);
    void proposal;
    void new Wp030LocalDouble(recorder);
    void new Wp031LocalDouble(recorder);
  });

  it('awaited rejection is visible in the snapshot path', async () => {
    await expect(runMatrixRow('WP-031', 'M12')).rejects.toBeInstanceOf(HarnessError);
  });
});

describe('shadow sealed output', () => {
  it('records sealed output and zero drained effects for shadow A', async () => {
    const snapshot = await runMatrixRow('WP-030', 'M11');
    expect(tenantCount(snapshot.drainedEffects, TENANT_A)).toBe(0);
    expect(tenantCount(snapshot.sealedOutputs, TENANT_A)).toBe(1);
  });
});
