import {
  Wp032ClinicalRecordDouble,
  type PhClinicalResource,
} from '@practicehub/clinical-contracts';

import { MemoryClinicalStore } from './store.js';

export class MedplumLocalAdapter {
  readonly id = 'medplum-local' as const;
  readonly mode = 'synthetic-local' as const;
  readonly store = new MemoryClinicalStore();
  readonly wp032 = new Wp032ClinicalRecordDouble();

  public async persist(resource: PhClinicalResource): Promise<PhClinicalResource> {
    const written = await this.store.put(resource);
    this.wp032.accept(written);
    return written;
  }
}
