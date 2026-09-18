/** Local WP-060 clinical-contracts double. Not the WP-060 leaf. Parity open. */

export const WP060_DOUBLE_VERSION = 'practicehub-clinical-contracts-v2-double';

export interface ClinicalContractObservation {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly resourceType: string;
  readonly id: string;
  readonly sourceVersion: string;
  readonly synthetic: true;
  readonly parityStatus: 'WP-060-integration-required';
}

export class Wp060ClinicalContractsDouble {
  readonly version = WP060_DOUBLE_VERSION;
  #last: ClinicalContractObservation | undefined;

  public accept(input: {
    readonly tenantId: string;
    readonly subjectRef: string;
    readonly resourceType: string;
    readonly id: string;
  }): ClinicalContractObservation {
    if (input.tenantId.length === 0 || input.subjectRef.length === 0) {
      throw new Error('WP061_CONTRACT_IDENTITY_INCOMPLETE');
    }
    this.#last = {
      tenantId: input.tenantId,
      subjectRef: input.subjectRef,
      resourceType: input.resourceType,
      id: input.id,
      sourceVersion: WP060_DOUBLE_VERSION,
      synthetic: true,
      parityStatus: 'WP-060-integration-required',
    };
    return this.#last;
  }

  public last(): ClinicalContractObservation | undefined {
    return this.#last;
  }
}
