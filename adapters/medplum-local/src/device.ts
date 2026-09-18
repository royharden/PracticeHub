import type { PhClinicalResource } from '@practicehub/clinical-contracts';
import { assertPhClinicalResource } from '@practicehub/clinical-contracts';

export interface SyntheticHl7Observation {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly loinc: string;
  readonly value: string;
}

export function normalizeDeviceObservation(message: SyntheticHl7Observation): PhClinicalResource {
  const resource: PhClinicalResource = {
    resourceType: 'Observation',
    id: `device-${message.loinc}`,
    tenantId: message.tenantId,
    subjectRef: message.subjectRef,
    sourceVersion: 'clinical-record-port-v1-double',
    coding: { system: 'http://loinc.org', code: message.loinc },
    synthetic: true,
  };
  assertPhClinicalResource(resource);
  if (message.value.length === 0) throw new Error('WP060_DEVICE_EMPTY_VALUE');
  return resource;
}
