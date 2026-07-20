export interface ClinicalAdapterDescriptor {
  readonly id: 'medplum';
  readonly contract: 'practicehub-clinical-v1';
  readonly mode: 'synthetic-local';
}

export const medplumAdapter: ClinicalAdapterDescriptor = {
  id: 'medplum',
  contract: 'practicehub-clinical-v1',
  mode: 'synthetic-local',
};
