import {
  assertPhClinicalResource,
  type PhClinicalResource,
  type ClinicalStore,
} from '@practicehub/clinical-contracts';

interface MedplumResourceEnvelope {
  readonly resourceType: string;
  readonly id: string;
  readonly meta: { readonly profile: readonly ['practicehub-clinical-contracts-v2'] };
  readonly contract: PhClinicalResource;
}

export class MemoryClinicalStore implements ClinicalStore {
  readonly #byId = new Map<string, PhClinicalResource>();

  public async put(resource: PhClinicalResource): Promise<PhClinicalResource> {
    assertPhClinicalResource(resource);
    this.#byId.set(resource.id, resource);
    return resource;
  }

  public async get(id: string): Promise<PhClinicalResource | undefined> {
    return this.#byId.get(id);
  }

  public async listBySubject(
    tenantId: string,
    subjectRef: string,
  ): Promise<readonly PhClinicalResource[]> {
    return [...this.#byId.values()].filter(
      (resource) => resource.tenantId === tenantId && resource.subjectRef === subjectRef,
    );
  }

  public async exportCorpus(): Promise<readonly PhClinicalResource[]> {
    return [...this.#byId.values()];
  }

  public async importCorpus(resources: readonly PhClinicalResource[]): Promise<void> {
    for (const resource of resources) {
      await this.put(resource);
    }
  }

  /** Medplum resource types exist only inside this adapter. */
  public toMedplumEnvelope(resource: PhClinicalResource): MedplumResourceEnvelope {
    return {
      resourceType: `Medplum${resource.resourceType}`,
      id: resource.id,
      meta: { profile: ['practicehub-clinical-contracts-v2'] },
      contract: resource,
    };
  }
}
