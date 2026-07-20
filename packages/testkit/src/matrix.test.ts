import { describe, expect, it } from 'vitest';

import {
  buildPersonaStoryMatrix,
  parsePersonaStoryMatrix,
  serializePersonaStoryMatrix,
} from './matrix.js';
import type { PersonaRegistryEntry } from './matrix.js';

const registry: PersonaRegistryEntry[] = [
  { slug: 'prospective-patient', name: 'prospective patient', class: 'patient/member' },
  { slug: 'it-security-admin', name: 'IT/security admin', class: 'compliance/privacy/security' },
];

const canonicalCsv = [
  'id,category,title,personas_primary,journey,n_acceptance,n_exceptions,n_sources,source_uids',
  'REQ-ID-001,identity,"Break-glass, reviewed",IT/security admin; prospective patient,denied-access-to-closure,3,2,1,CDX:ID-001',
  'REQ-ID-002,identity,Provisional identity,prospective patient,,3,2,1,CDX:ID-002',
].join('\n');

describe('buildPersonaStoryMatrix', () => {
  it('emits one row per requirement × primary persona, in corpus order', () => {
    const rows = buildPersonaStoryMatrix(canonicalCsv, registry);
    expect(rows.map((row) => `${row.canonicalId}:${row.personaSlug}`)).toEqual([
      'REQ-ID-001:it-security-admin',
      'REQ-ID-001:prospective-patient',
      'REQ-ID-002:prospective-patient',
    ]);
    expect(rows[0]?.requiredFixtureClasses).toEqual(['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY']);
    expect(rows[2]?.journey).toBe('');
  });

  it('fails closed on a persona missing from the registry', () => {
    expect(() => buildPersonaStoryMatrix(canonicalCsv, registry.slice(0, 1))).toThrow(
      /names persona "IT\/security admin" absent/,
    );
  });
});

describe('serialize/parse round trip', () => {
  it('round-trips losslessly and passes the floor check', () => {
    const rows = buildPersonaStoryMatrix(canonicalCsv, registry);
    const text = serializePersonaStoryMatrix(rows);
    expect(parsePersonaStoryMatrix(text)).toEqual(rows);
  });

  it('rejects a row seeded below the fixture floor', () => {
    const text = serializePersonaStoryMatrix(buildPersonaStoryMatrix(canonicalCsv, registry));
    const tampered = text.replace('HAPPY;BOUNDARY;FAILURE;RECOVERY', 'HAPPY;BOUNDARY;FAILURE');
    expect(() => parsePersonaStoryMatrix(tampered)).toThrow(/below the fixture floor.*RECOVERY/);
  });

  it('rejects a header drift', () => {
    const text = serializePersonaStoryMatrix(buildPersonaStoryMatrix(canonicalCsv, registry));
    expect(() => parsePersonaStoryMatrix(text.replace('persona_class', 'personaClass'))).toThrow(
      /header mismatch/,
    );
  });
});
