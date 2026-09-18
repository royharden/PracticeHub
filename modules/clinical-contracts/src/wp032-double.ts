import { WP032_DOUBLE_VERSION, type PhClinicalResource } from './resources.js';
import { assertPhClinicalResource } from './validate.js';

export interface Wp032ClinicalRecordObservation {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly requestedSourceVersion: string;
  readonly observedSourceVersion: string;
  readonly effectRef: string;
  readonly state: 'accepted' | 'reconciled' | 'unknown';
  readonly synthetic: true;
  readonly parityStatus: 'WP-032-integration-required';
}

/**
 * Local WP-032 double. Not canonical clinical-core. Parity remains open.
 */
export class Wp032ClinicalRecordDouble {
  readonly version = WP032_DOUBLE_VERSION;
  readonly parityStatus = 'WP-032-integration-required' as const;
  #observation: Wp032ClinicalRecordObservation | undefined;

  public accept(resource: PhClinicalResource): Wp032ClinicalRecordObservation {
    assertPhClinicalResource(resource);
    this.#observation = {
      tenantId: resource.tenantId,
      subjectRef: resource.subjectRef,
      requestedSourceVersion: WP032_DOUBLE_VERSION,
      observedSourceVersion: resource.sourceVersion,
      effectRef: `${resource.resourceType}/${resource.id}`,
      state: 'accepted',
      synthetic: true,
      parityStatus: 'WP-032-integration-required',
    };
    return this.#observation;
  }

  public observation(): Wp032ClinicalRecordObservation | undefined {
    return this.#observation;
  }
}
