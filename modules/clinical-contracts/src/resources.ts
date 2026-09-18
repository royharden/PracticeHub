export const phClinicalResourceTypes = [
  'PatientLink',
  'Encounter',
  'Condition',
  'AllergyIntolerance',
  'MedicationRequest',
  'ServiceRequest',
  'Observation',
  'DiagnosticReport',
  'DocumentReferenceLink',
  'CarePlan',
  'PractitionerRole',
  'Coverage',
] as const;

export type PhClinicalResourceType = (typeof phClinicalResourceTypes)[number];

export interface Coding {
  readonly system: string;
  readonly code: string;
  readonly display?: string;
}

export interface PhClinicalResource {
  readonly resourceType: PhClinicalResourceType;
  readonly id: string;
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly sourceVersion: string;
  readonly coding: Coding;
  readonly synthetic: true;
}

export const WP032_DOUBLE_VERSION = 'clinical-record-port-v1-double';
export const PH_CLINICAL_CONTRACT_VERSION = 'practicehub-clinical-contracts-v2';

export function isPhClinicalResourceType(value: string): value is PhClinicalResourceType {
  return (phClinicalResourceTypes as readonly string[]).includes(value);
}
