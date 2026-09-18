import { isPhClinicalResourceType, type PhClinicalResource, type Coding } from './resources.js';

const KNOWN_SYSTEMS = new Set([
  'http://loinc.org',
  'http://snomed.info/sct',
  'http://www.nlm.nih.gov/research/umls/rxnorm',
]);

export function assertCoding(coding: Coding): void {
  if (coding.system.length === 0 || coding.code.length === 0) {
    throw new Error('WP060_TERMINOLOGY_INCOMPLETE');
  }
  if (!KNOWN_SYSTEMS.has(coding.system)) {
    throw new Error(`WP060_TERMINOLOGY_UNKNOWN_SYSTEM:${coding.system}`);
  }
}

export function assertPhClinicalResource(value: PhClinicalResource): void {
  if (!isPhClinicalResourceType(value.resourceType)) {
    throw new Error(`WP060_UNKNOWN_RESOURCE_TYPE:${value.resourceType}`);
  }
  if (value.tenantId.length === 0 || value.subjectRef.length === 0 || value.id.length === 0) {
    throw new Error('WP060_IDENTITY_INCOMPLETE');
  }
  if (value.synthetic !== true) {
    throw new Error('WP060_NON_SYNTHETIC');
  }
  assertCoding(value.coding);
}

export function assertSameTenantSubject(left: PhClinicalResource, right: PhClinicalResource): void {
  if (left.tenantId !== right.tenantId || left.subjectRef !== right.subjectRef) {
    throw new Error('WP060_CORRELATION_MISMATCH');
  }
}
