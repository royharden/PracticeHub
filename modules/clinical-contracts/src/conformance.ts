import type { PhClinicalResource } from './resources.js';
import { assertPhClinicalResource, assertSameTenantSubject } from './validate.js';

export interface ClinicalStore {
  put(resource: PhClinicalResource): Promise<PhClinicalResource>;
  get(id: string): Promise<PhClinicalResource | undefined>;
  listBySubject(tenantId: string, subjectRef: string): Promise<readonly PhClinicalResource[]>;
  exportCorpus(): Promise<readonly PhClinicalResource[]>;
  importCorpus(resources: readonly PhClinicalResource[]): Promise<void>;
}

export async function roundTrip(
  store: ClinicalStore,
  resource: PhClinicalResource,
): Promise<PhClinicalResource> {
  assertPhClinicalResource(resource);
  const written = await store.put(resource);
  assertSameTenantSubject(resource, written);
  const read = await store.get(resource.id);
  if (read === undefined) throw new Error('WP060_ROUNDTRIP_MISSING');
  assertSameTenantSubject(resource, read);
  if (read.resourceType !== resource.resourceType || read.coding.code !== resource.coding.code) {
    throw new Error('WP060_ROUNDTRIP_DRIFT');
  }
  return read;
}

export async function rehydrateInto(
  source: ClinicalStore,
  vanilla: ClinicalStore,
): Promise<number> {
  const corpus = await source.exportCorpus();
  await vanilla.importCorpus(corpus);
  for (const resource of corpus) {
    await roundTrip(vanilla, resource);
  }
  return corpus.length;
}
