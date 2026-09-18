import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { phClinicalResourceTypes, type PhClinicalResource } from './resources.js';
import { assertPhClinicalResource, assertCoding } from './validate.js';
import { Wp032ClinicalRecordDouble } from './wp032-double.js';

const directory = dirname(fileURLToPath(import.meta.url));
const fixtureClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;

function loadFixture(name: (typeof fixtureClasses)[number]): {
  readonly requirementId: string;
  readonly fixtureClass: string;
  readonly synthetic: true;
  readonly cases: readonly { readonly resource: PhClinicalResource }[];
} {
  const raw = JSON.parse(
    readFileSync(resolve(directory, `../fixtures/WP-060.${name}.json`), 'utf8'),
  ) as {
    readonly requirementId: string;
    readonly fixtureClass: string;
    readonly synthetic: true;
    readonly cases: readonly { readonly resource: PhClinicalResource }[];
  };
  if (raw.requirementId !== 'WP-060' || raw.fixtureClass !== name || raw.synthetic !== true) {
    throw new Error(`INVALID_WP060_FIXTURE:${name}`);
  }
  return raw;
}

describe('WP-060 clinical contracts', () => {
  it('declares the ADR-013 resource set', () => {
    expect(phClinicalResourceTypes).toHaveLength(12);
  });

  it('rejects unknown terminology systems', () => {
    expect(() => assertCoding({ system: 'http://example.invalid/codes', code: 'x' })).toThrow(
      'WP060_TERMINOLOGY_UNKNOWN_SYSTEM',
    );
  });

  it('WP-032 double accepts a synthetic observation without claiming parity', () => {
    const port = new Wp032ClinicalRecordDouble();
    const observation = port.accept({
      resourceType: 'Observation',
      id: 'obs-1',
      tenantId: 'northwind-synthetic',
      subjectRef: 'wp060-subject-1',
      sourceVersion: 'clinical-record-port-v1-double',
      coding: { system: 'http://loinc.org', code: '8867-4' },
      synthetic: true,
    });
    expect(observation.parityStatus).toBe('WP-032-integration-required');
    expect(observation.state).toBe('accepted');
  });

  it.each(fixtureClasses)('%s fixtures validate as PracticeHub clinical resources', (name) => {
    const pack = loadFixture(name);
    for (const candidate of pack.cases) {
      expect(() => assertPhClinicalResource(candidate.resource)).not.toThrow();
    }
  });
});
