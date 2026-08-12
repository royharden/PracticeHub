import { describe, expect, it } from 'vitest';

import {
  assertObservedAttributeNames,
  importSyntheaExport,
  type SyntheaExport,
} from './synthea.js';

const permitted = { conditions: ['SYN-COND-001'], medications: ['SYN-MED-001'] };

function exportWith(overrides: Partial<SyntheaExport> = {}): SyntheaExport {
  return {
    generator: { name: 'synthea-runner', version: 'stub-v1' },
    seed: 'seed',
    patients: [
      { subjectRef: 'sg-p-0001', birthDate: '1990-04-02', residenceState: 'NV', city: 'Ridgeline' },
    ],
    conditions: [
      { subjectRef: 'sg-p-0001', code: 'SYN-COND-001', description: 'c', onsetDate: '2020-01-01' },
    ],
    medications: [
      { subjectRef: 'sg-p-0001', code: 'SYN-MED-001', description: 'm', startDate: '2021-01-01' },
    ],
    encounters: [
      {
        subjectRef: 'sg-p-0001',
        encounterRef: 'sy-enc-1',
        encounterClass: 'ambulatory',
        startDate: '2025-01-01',
      },
    ],
    synthetic: true,
    ...overrides,
  };
}

describe('importSyntheaExport', () => {
  it('maps rows onto the backbone for known subjects', () => {
    const result = importSyntheaExport(exportWith(), ['sg-p-0001'], permitted);
    expect(result.quarantine).toEqual([]);
    expect(result.backbone).toHaveLength(1);
    expect(result.backbone[0]?.conditions).toHaveLength(1);
    expect(result.backbone[0]?.medications).toHaveLength(1);
    expect(result.backbone[0]?.encounters).toHaveLength(1);
    expect(result.backbone[0]?.synthetic).toBe(true);
  });

  it('QUARANTINES an orphaned row rather than importing it against a guess', () => {
    const result = importSyntheaExport(
      exportWith({
        conditions: [
          {
            subjectRef: 'sy-orphan-1',
            code: 'SYN-COND-001',
            description: 'c',
            onsetDate: '2020-01-01',
          },
        ],
      }),
      ['sg-p-0001'],
      permitted,
    );
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0]?.reason).toBe('unresolved-subject');
    expect(result.quarantine[0]?.observedAttributeNames).toEqual(['subjectRef']);
    // The orphan never reaches the backbone under any subject.
    expect(result.backbone.flatMap((entry) => entry.conditions)).toHaveLength(0);
  });

  it('quarantines a patient row missing a required field instead of partially importing it', () => {
    const result = importSyntheaExport(
      exportWith({
        patients: [
          { subjectRef: 'sg-p-0001', birthDate: '', residenceState: '', city: 'Ridgeline' },
        ],
      }),
      ['sg-p-0001'],
      permitted,
    );
    expect(result.backbone).toHaveLength(0);
    expect(result.quarantine[0]?.reason).toBe('missing-required-field');
    expect(result.quarantine[0]?.observedAttributeNames).toEqual(['birthDate', 'residenceState']);
  });

  it('quarantines an unmapped code rather than inventing a mapping', () => {
    const result = importSyntheaExport(
      exportWith({
        conditions: [
          {
            subjectRef: 'sg-p-0001',
            code: 'SYN-COND-999',
            description: 'c',
            onsetDate: '2020-01-01',
          },
        ],
      }),
      ['sg-p-0001'],
      permitted,
    );
    expect(result.quarantine[0]?.reason).toBe('unmapped-code');
    expect(result.quarantine[0]?.observedAttributeNames).toEqual(['code']);
  });

  it('a structurally unreadable export halts with a file-level error, not a partial report', () => {
    const broken = { ...exportWith(), patients: undefined } as unknown as SyntheaExport;
    const result = importSyntheaExport(broken, ['sg-p-0001'], permitted);
    expect(result.backbone).toEqual([]);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine[0]?.reason).toBe('structurally-unreadable-export');
    expect(result.quarantine[0]?.rowKind).toBe('export');
  });

  it('refuses an export without the synthetic watermark', () => {
    const unwatermarked = { ...exportWith(), synthetic: false } as unknown as SyntheaExport;
    expect(() => importSyntheaExport(unwatermarked, ['sg-p-0001'], permitted)).toThrow(
      /synthetic watermark/,
    );
  });

  it('orders the backbone deterministically by subject', () => {
    const many = exportWith({
      patients: [
        { subjectRef: 'sg-p-0003', birthDate: '1990-01-01', residenceState: 'NV', city: 'A' },
        { subjectRef: 'sg-p-0001', birthDate: '1990-01-01', residenceState: 'NV', city: 'A' },
        { subjectRef: 'sg-p-0002', birthDate: '1990-01-01', residenceState: 'NV', city: 'A' },
      ],
      conditions: [],
      medications: [],
      encounters: [],
    });
    const result = importSyntheaExport(many, ['sg-p-0001', 'sg-p-0002', 'sg-p-0003'], permitted);
    expect(result.backbone.map((entry) => entry.subjectRef)).toEqual([
      'sg-p-0001',
      'sg-p-0002',
      'sg-p-0003',
    ]);
  });
});

describe('quarantine records carry attribute NAMES only', () => {
  it('accepts known attribute names', () => {
    expect(() => {
      assertObservedAttributeNames(['birthDate', 'code']);
    }).not.toThrow();
  });

  it('REFUSES a value smuggled in where a name belongs', () => {
    expect(() => {
      assertObservedAttributeNames(['1990-04-02']);
    }).toThrow(/attribute NAMES only/);
    expect(() => {
      assertObservedAttributeNames(['birthDate', 'Wren Underhill']);
    }).toThrow(/attribute NAMES only/);
  });

  it('refuses an empty name list — a quarantine with no reason is not triage', () => {
    expect(() => {
      assertObservedAttributeNames([]);
    }).toThrow(/at least one/);
  });
});
