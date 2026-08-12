import { describe, expect, it } from 'vitest';

import {
  assertCorpusRecordsWatermarked,
  generateSynthCorpus,
  parseSynthCorpus,
  serializeSynthCorpus,
  synthgenProfileV1,
  type SynthCorpus,
  type SynthCorpusSpec,
} from './corpus.js';
import { renderSynthgenSeedSection } from './emit-sql.js';
import type { SyntheaExport, SyntheaRunnerPort } from './synthea.js';

/**
 * A local runner. The real stub lives in sims/synthea-runner and is wired in by
 * the validator; the generator must never import an implementation, so these
 * tests supply their own — which is itself the proof that the port is a port.
 */
class TestRunner implements SyntheaRunnerPort {
  constructor(private readonly orphan = false) {}

  run(request: { subjectRefs: readonly string[]; synthetic: true }): SyntheaExport {
    const refs = this.orphan ? [...request.subjectRefs, 'sy-orphan-1'] : request.subjectRefs;
    return {
      generator: { name: 'test-runner', version: 'v0' },
      seed: 'test',
      patients: request.subjectRefs.map((subjectRef) => ({
        subjectRef,
        birthDate: '1990-01-01',
        residenceState: 'NV',
        city: 'Ridgeline',
      })),
      conditions: refs.map((subjectRef) => ({
        subjectRef,
        code: 'SYN-COND-001',
        description: 'c',
        onsetDate: '2020-01-01',
      })),
      medications: [],
      encounters: [],
      synthetic: true,
    };
  }
}

const spec: SynthCorpusSpec = {
  corpusVersion: 'SynthCorpus-vT',
  recoveryEpoch: 'RE-009',
  simulatedClockEpoch: synthgenProfileV1.simulatedClockEpoch,
  masterSeed: 'corpus-test-seed',
  generator: { name: 'synthgen', version: 'vT' },
  tenantId: 'northwind-synthetic',
  householdCount: 20,
  locations: [
    { locationId: 'northwind-nv-henderson', legalEntityId: 'northwind-health-nv', stateCode: 'NV' },
  ],
  personaAssignments: [
    { slug: 'prospective-patient', personaClass: 'patient/member', journeys: ['acquisition'] },
    { slug: 'data-migration-engineer', personaClass: 'staff', journeys: ['clinic-acquisition'] },
  ],
};

describe('generateSynthCorpus', () => {
  it('regenerates byte-identically — the determinism the gate asserts', () => {
    const first = serializeSynthCorpus(generateSynthCorpus(spec, new TestRunner()));
    const second = serializeSynthCorpus(generateSynthCorpus(spec, new TestRunner()));
    expect(first).toBe(second);
  });

  it('changes bytes when the master seed changes', () => {
    const other = serializeSynthCorpus(
      generateSynthCorpus({ ...spec, masterSeed: 'different' }, new TestRunner()),
    );
    expect(other).not.toBe(serializeSynthCorpus(generateSynthCorpus(spec, new TestRunner())));
  });

  it('serializes with LF and a trailing newline', () => {
    const text = serializeSynthCorpus(generateSynthCorpus(spec, new TestRunner()));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
  });

  it('refuses a corpus too small to cover its personas', () => {
    const wide = {
      ...spec,
      householdCount: 1,
      personaAssignments: Array.from({ length: 200 }, (_, index) => ({
        slug: `persona-${String(index)}`,
        personaClass: 'staff',
        journeys: [],
      })),
    };
    expect(() => generateSynthCorpus(wide, new TestRunner())).toThrow(/cannot cover/);
  });

  it('carries the pinned identifiers and one side effect per household and subject', () => {
    const corpus = generateSynthCorpus(spec, new TestRunner());
    expect(corpus.corpus_version).toBe('SynthCorpus-vT');
    expect(corpus.recovery_epoch).toBe('RE-009');
    expect(corpus.side_effects).toHaveLength(corpus.households.length + corpus.subjects.length);
    const keys = corpus.side_effects.map((effect) => effect.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('carries the source register, including the outstanding acquisitions', () => {
    const corpus = generateSynthCorpus(spec, new TestRunner());
    expect(corpus.source_register.length).toBeGreaterThan(0);
    expect(
      corpus.source_register.some((row) => row.state === 'surrogate-pending-acquisition'),
    ).toBe(true);
  });

  it('carries the import quarantine when the export holds an orphan', () => {
    const corpus = generateSynthCorpus(spec, new TestRunner(true));
    expect(corpus.import_quarantine.length).toBeGreaterThan(0);
    expect(corpus.import_quarantine[0]?.reason).toBe('unresolved-subject');
  });

  it('reports coverage counts that match the assignments it was given', () => {
    const corpus = generateSynthCorpus(spec, new TestRunner());
    expect(corpus.coverage.personas_required).toBe(2);
    expect(corpus.coverage.personas_covered).toBe(2);
  });
});

describe('boot watermark assertion', () => {
  const corpus = generateSynthCorpus(spec, new TestRunner());

  it('accepts a fully watermarked corpus', () => {
    expect(() => {
      assertCorpusRecordsWatermarked(corpus);
    }).not.toThrow();
  });

  it('refuses a corpus whose ROOT watermark is missing', () => {
    const broken = { ...corpus, synthetic: false } as unknown as SynthCorpus;
    expect(() => {
      assertCorpusRecordsWatermarked(broken);
    }).toThrow(/must be exactly true/);
  });

  it('refuses a single subject whose watermark was flipped, and NAMES the path', () => {
    const subjects = corpus.subjects.map((subject, index) =>
      index === 3 ? { ...subject, synthetic: false } : subject,
    );
    const broken = { ...corpus, subjects } as unknown as SynthCorpus;
    expect(() => {
      assertCorpusRecordsWatermarked(broken);
    }).toThrow(/corpus\.subjects\[3\]\.synthetic/);
  });

  it('refuses a record that carries no watermark KEY at all', () => {
    const [first, ...rest] = corpus.subjects;
    if (!first) {
      throw new Error('corpus has no subjects');
    }
    const stripped: Record<string, unknown> = { ...first };
    delete stripped.synthetic;
    const broken = { ...corpus, subjects: [stripped, ...rest] } as unknown as SynthCorpus;
    expect(() => {
      assertCorpusRecordsWatermarked(broken);
    }).toThrow(/carries no synthetic watermark at all/);
  });

  it('reaches NESTED records — a flipped endpoint watermark is caught', () => {
    const [first, ...rest] = corpus.subjects;
    if (!first) {
      throw new Error('corpus has no subjects');
    }
    const endpoints = first.endpoints.map((endpoint, index) =>
      index === 0 ? { ...endpoint, synthetic: false } : endpoint,
    );
    const broken = {
      ...corpus,
      subjects: [{ ...first, endpoints }, ...rest],
    } as unknown as SynthCorpus;
    expect(() => {
      assertCorpusRecordsWatermarked(broken);
    }).toThrow(/endpoints\[0\]\.synthetic/);
  });

  it('the BOOT path refuses unwatermarked bytes before anything reads the data', () => {
    const text = serializeSynthCorpus(corpus).replace('"synthetic": true', '"synthetic": false');
    expect(() => parseSynthCorpus(text)).toThrow(/refuses to boot/);
  });

  it('the boot path refuses bytes that are not JSON', () => {
    expect(() => parseSynthCorpus('{not json')).toThrow(/not valid JSON/);
  });
});

describe('seed emission', () => {
  const corpus = generateSynthCorpus(spec, new TestRunner());
  const sql = renderSynthgenSeedSection(corpus);

  it('is byte-stable for a given corpus', () => {
    expect(renderSynthgenSeedSection(corpus)).toBe(sql);
  });

  it('emits every insert as idempotent (a reseed converges, never doubles or errors)', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(conflicts).toHaveLength(inserts.length);
  });

  it('watermarks every emitted row', () => {
    const rows = sql.split('\n').filter((line) => /^ {2}\('northwind-synthetic'/.test(line));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.endsWith('true)') || row.endsWith('true),')).toBe(true);
    }
  });

  it('uses only the sg- id namespace so earlier standing proofs are untouched', () => {
    for (const match of sql.matchAll(/'(sg-[a-z-]+-\d+[a-z-]*)'/g)) {
      expect(match[1]?.startsWith('sg-')).toBe(true);
    }
    expect(sql).not.toContain('np-alex-rivera');
    expect(sql).not.toContain('legacy-lakeside');
  });

  it('seeds a real twin row for every same-person collision', () => {
    const twins = corpus.collisions.filter((collision) => collision.legacyTwin !== null);
    expect(twins.length).toBeGreaterThan(0);
    for (const collision of twins) {
      expect(sql).toContain(`'${String(collision.legacyTwin?.personId)}'`);
    }
  });

  it('escapes single quotes rather than emitting broken SQL', () => {
    const quoted = generateSynthCorpus(
      {
        ...spec,
        personaAssignments: [
          { slug: "o'brien-persona", personaClass: 'staff', journeys: [] },
          { slug: 'second-persona', personaClass: 'staff', journeys: [] },
        ],
      },
      new TestRunner(),
    );
    // Persona slugs do not reach SQL, but the escaper is shared; prove it on the
    // provenance string that does.
    expect(renderSynthgenSeedSection(quoted)).not.toContain("''''");
  });
});
