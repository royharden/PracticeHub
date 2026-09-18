import { createHash } from 'node:crypto';

import {
  VendorSimEngine,
  type RailResponse,
  type RailSim,
  type SimReceipt,
} from '@practicehub/vendor-sim-kit';

import type { LoopBinding, OwnedException, ProductObservation } from '../harness.js';
import type { KillPoint } from '../manifest.js';

export const clinicalLoopV1DoubleContract = Object.freeze({
  contractVersion: '4C-clinical-v1-double',
  parityStatus: 'WP-032-integration-required',
  railId: 'RAIL-002',
  authorityId: 'AUTH-007',
  operation: 'read-clinical-summary',
  requestIdentity: ['tenantId', 'subjectRef', 'requestedSourceVersion', 'idempotencyKey'],
  runtimeStates: ['accepted', 'unknown', 'reconciled'],
  unknownDisposition: 'owned-timed-exception',
  signedTruthMutation: 'forbidden',
  synthetic: true,
} as const);

export const clinicalLoopV1DoubleContractSha256 = createHash('sha256')
  .update(JSON.stringify(clinicalLoopV1DoubleContract))
  .digest('hex');

export const athenaClinicalV1DoubleRail: RailSim = {
  railId: 'RAIL-002',
  authorityId: 'AUTH-007',
  name: 'athena-clinical-v1-double',
  pinnedVendorVersion: 'pm-api-v1',
  operations: ['read-clinical-summary'],
  presets: [],
  heartbeat: { expectedEffectsPerWindow: 60, volumeTolerance: 15, emitsIdleHeartbeat: true },
  effectKeyFor: (operation, request) =>
    `rail-002-${createHash('sha256')
      .update(JSON.stringify([operation, request.idempotencyKey]))
      .digest('hex')}`,
};

interface ClinicalObservation {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly requestedSourceVersion: string;
  readonly observedSourceVersion: string;
  readonly effectRef: string;
  readonly state: 'accepted' | 'unknown' | 'reconciled';
  readonly observedAt: string;
  readonly synthetic: true;
}

export class ClinicalLoopV1Binding implements LoopBinding {
  readonly #responses: RailResponse[] = [];
  readonly #evidenceRefs: string[] = [];
  readonly #receipts: SimReceipt[] = [];
  #observation: ClinicalObservation | undefined;
  #ownedException: OwnedException | undefined;
  #transitionCount = 0;
  #terminalRegression = false;
  #dispatchAttempts = 0;
  readonly #holdVersionDrift: boolean;

  public constructor(
    private readonly engine: VendorSimEngine,
    private readonly applicationKey: string,
    options: { readonly holdVersionDrift?: boolean } = {},
  ) {
    this.#holdVersionDrift = options.holdVersionDrift === true;
  }

  public dispatch(): Promise<void> {
    this.#dispatchAttempts += 1;
    const response = this.engine.dispatch({
      railId: 'RAIL-002',
      operation: 'read-clinical-summary',
      idempotencyKey: this.applicationKey,
      payloadRef: 'clinical-summary:wp033-subject-1',
      requestedAt: '2026-09-12T15:00:00.000Z',
      payload: {
        tenantId: 'northwind-synthetic',
        subjectRef: 'wp033-subject-1',
        requestedSourceVersion: 'athena-clinical-v1',
      },
      synthetic: true,
    });
    this.#responses.push(response);
    this.recordResponse(response);
    return Promise.resolve();
  }

  public async recover(killPoint: KillPoint): Promise<void> {
    if (killPoint === 'after-effect-before-receipt') {
      const effect = this.engine.snapshot().effects[0];
      if (effect === undefined || effect.state !== 'unknown') {
        throw new Error('WP033_CLINICAL_UNKNOWN_LEDGER_REQUIRED');
      }
      this.#observation = {
        tenantId: 'northwind-synthetic',
        subjectRef: 'wp033-subject-1',
        requestedSourceVersion: 'athena-clinical-v1',
        observedSourceVersion: 'pm-api-v1',
        effectRef: effect.effectKey,
        state: 'unknown',
        observedAt: effect.lastSeenAt,
        synthetic: true,
      };
      this.holdUnknown('CLINICAL_SOURCE_UNKNOWN');
      return;
    }
    await this.dispatch();
  }

  public settle(): Promise<void> {
    const receipts = this.engine.drainReceipts('RAIL-002');
    this.#receipts.push(...receipts);
    for (const receipt of receipts) this.applyReceipt(receipt);
    if (this.#observation?.state === 'unknown') this.holdUnknown('CLINICAL_RECEIPT_MISSING');
    return Promise.resolve();
  }

  public productObservation(): ProductObservation {
    return {
      state: this.#observation?.state ?? 'not-dispatched',
      transitionCount: this.#transitionCount,
      evidenceRefs: [...this.#evidenceRefs],
      ...(this.#ownedException === undefined ? {} : { ownedException: this.#ownedException }),
      correlationExact:
        this.#observation === undefined ||
        (this.#observation.tenantId === 'northwind-synthetic' &&
          this.#observation.subjectRef === 'wp033-subject-1' &&
          this.#observation.requestedSourceVersion === 'athena-clinical-v1'),
      terminalRegression: this.#terminalRegression,
      recoveryAttempts: this.#dispatchAttempts,
      receiptIngressCount: this.#receipts.length,
    };
  }

  public railResponses(): readonly RailResponse[] {
    return this.#responses;
  }

  public receipts(): readonly SimReceipt[] {
    return this.#receipts;
  }

  public ingestMismatchedSubject(): void {
    const response = this.#responses[0];
    if (response === undefined) throw new Error('WP033_CLINICAL_NO_RESPONSE');
    this.recordResponse(response, {
      tenantId: 'northwind-synthetic',
      subjectRef: 'wp033-subject-OTHER',
    });
  }

  private recordResponse(
    response: RailResponse,
    identity: { readonly tenantId: string; readonly subjectRef: string } = {
      tenantId: 'northwind-synthetic',
      subjectRef: 'wp033-subject-1',
    },
  ): void {
    const state = response.effectState === 'landed' ? 'accepted' : 'unknown';
    const next: ClinicalObservation = {
      tenantId: identity.tenantId,
      subjectRef: identity.subjectRef,
      requestedSourceVersion: 'athena-clinical-v1',
      observedSourceVersion: response.vendorVersion,
      effectRef: response.effectKey,
      state,
      observedAt: '2026-09-12T15:00:00.000Z',
      synthetic: true,
    };
    if (
      this.#observation !== undefined &&
      (this.#observation.effectRef !== next.effectRef ||
        this.#observation.tenantId !== next.tenantId ||
        this.#observation.subjectRef !== next.subjectRef)
    ) {
      throw new Error('WP033_CLINICAL_CORRELATION_MISMATCH');
    }
    if (this.#observation?.state === 'reconciled' && next.state !== 'reconciled') {
      this.#terminalRegression = true;
      throw new Error('WP033_CLINICAL_TERMINAL_REGRESSION');
    }
    this.#observation = next;
  }

  private applyReceipt(receipt: SimReceipt): void {
    if (this.#observation === undefined || receipt.effectKey !== this.#observation.effectRef) {
      throw new Error('WP033_CLINICAL_RECEIPT_CORRELATION_MISMATCH');
    }
    if (
      this.#holdVersionDrift &&
      this.#observation.observedSourceVersion !== this.#observation.requestedSourceVersion
    ) {
      if (this.#observation.state === 'reconciled') {
        this.#terminalRegression = true;
        throw new Error('WP033_CLINICAL_SIGNED_TRUTH_MUTATION');
      }
      this.holdUnknown('CLINICAL_VERSION_DRIFT');
      this.#evidenceRefs.push(`${receipt.receiptRef}:${String(receipt.sequence)}:held-drift`);
      return;
    }
    if (this.#observation.state !== 'reconciled') this.#transitionCount += 1;
    this.#observation = { ...this.#observation, state: 'reconciled' };
    this.#evidenceRefs.push(`${receipt.receiptRef}:${String(receipt.sequence)}`);
    this.#ownedException = undefined;
  }

  private holdUnknown(reason: string): void {
    this.#ownedException ??= {
      ownerRef: 'synthetic-staff:clinical-reconciliation-1',
      dueAt: '2026-09-12T15:15:00.000Z',
      reason,
      evidenceRef: `clinical-exception:${this.applicationKey}`,
    };
  }
}

export async function runClinicalSubjectFenceProbe(): Promise<{ readonly rejected: true }> {
  const engine = new VendorSimEngine({ rails: [athenaClinicalV1DoubleRail] });
  const binding = new ClinicalLoopV1Binding(engine, 'wp033-clinical-subject-fence');
  await binding.dispatch();
  try {
    binding.ingestMismatchedSubject();
  } catch (error) {
    if (error instanceof Error && error.message === 'WP033_CLINICAL_CORRELATION_MISMATCH') {
      return { rejected: true };
    }
    throw error;
  }
  throw new Error('WP033_CLINICAL_SUBJECT_FENCE_NOT_BITING');
}

export async function runClinicalVersionDriftProbe(): Promise<{
  readonly state: string;
  readonly held: boolean;
  readonly reason: string | undefined;
  readonly transitionCount: number;
}> {
  const engine = new VendorSimEngine({ rails: [athenaClinicalV1DoubleRail] });
  const binding = new ClinicalLoopV1Binding(engine, 'wp033-clinical-drift-key', {
    holdVersionDrift: true,
  });
  await binding.dispatch();
  await binding.settle();
  const product = binding.productObservation();
  return {
    state: product.state,
    held: product.ownedException?.reason === 'CLINICAL_VERSION_DRIFT',
    reason: product.ownedException?.reason,
    transitionCount: product.transitionCount,
  };
}
