/**
 * Corpus assembly, serialization, and the BOOT WATERMARK assertion
 * (WP-029 verification gate, clauses 2 and 3).
 *
 * `SynthCorpus vN = (pinned sources + mappings) + (synthgen version + master
 * seed) + adversarial pack` (synthetic-data-plan §6). This module composes the
 * identity world and the imported clinical backbone into that object, and
 * fixes its serialization so that regeneration is byte-stable.
 *
 * BOOT WATERMARK: `loadSynthCorpus` refuses a corpus in which ANY record lacks
 * `synthetic: true`, naming the exact path. D3's "no real PHI ever touches the
 * local environment" is only as strong as the moment it is checked, and the
 * moment that matters is load — before anything is seeded, not after. A
 * watermark checked only at generation time protects a file nobody is loading.
 */
import { readFileSync } from 'node:fs';

import { createSimulatedClock } from './clock.js';
import { evaluatePersonaStoryCoverage, type CoverageSubject } from './coverage.js';
import { buildCorpusSideEffect, type CorpusSideEffect } from './epoch.js';
import {
  generateIdentityWorld,
  overlapIsMergeSufficient,
  type CorpusHousehold,
  type CorpusSubject,
  type IdentityCollision,
} from './identity.js';
import {
  importSyntheaExport,
  type ClinicalBackboneEntry,
  type ImportQuarantineRecord,
  type SyntheaRunnerPort,
} from './synthea.js';
import {
  conditionCatalog,
  medicationCatalog,
  sourceRegisterV1,
  type CorpusSourceRegisterRow,
} from './vocab.js';

export interface CorpusLocationSpec {
  readonly locationId: string;
  readonly legalEntityId: string;
  readonly stateCode: string;
}

export interface CorpusPersonaAssignment {
  readonly slug: string;
  readonly personaClass: string;
  readonly journeys: readonly string[];
}

export interface SynthCorpusSpec {
  readonly corpusVersion: string;
  readonly recoveryEpoch: string;
  readonly simulatedClockEpoch: string;
  readonly masterSeed: string;
  readonly generator: { readonly name: string; readonly version: string };
  readonly tenantId: string;
  readonly householdCount: number;
  readonly locations: readonly CorpusLocationSpec[];
  readonly personaAssignments: readonly CorpusPersonaAssignment[];
}

export interface SynthCorpus {
  readonly synthetic: true;
  readonly corpus_version: string;
  readonly recovery_epoch: string;
  readonly simulated_clock_epoch: string;
  readonly master_seed: string;
  readonly generator: { readonly name: string; readonly version: string };
  readonly tenant_id: string;
  readonly source_register: readonly CorpusSourceRegisterRow[];
  readonly households: readonly CorpusHousehold[];
  readonly subjects: readonly CorpusSubject[];
  readonly collisions: readonly IdentityCollision[];
  readonly clinical_backbone: readonly ClinicalBackboneEntry[];
  readonly import_quarantine: readonly ImportQuarantineRecord[];
  readonly side_effects: readonly CorpusSideEffect[];
  readonly coverage: {
    readonly personas_required: number;
    readonly personas_covered: number;
    readonly journeys_required: number;
    readonly journeys_covered: number;
  };
}

/**
 * The pinned v1 profile. Sizing is DATA: a corpus that needs more volume bumps
 * these numbers and its corpus version, which is a reviewed change with a
 * regenerated fence — not a generator edit.
 */
export const synthgenProfileV1 = {
  generator: { name: 'synthgen', version: 'v1' },
  corpusVersion: 'SynthCorpus-v1',
  recoveryEpoch: 'RE-001',
  simulatedClockEpoch: '2026-01-01T00:00:00Z',
  masterSeed: 'practicehub-synthcorpus-v1',
  tenantId: 'northwind-synthetic',
  householdCount: 48,
  /**
   * Deliberate defect rate in the Synthea import: one in this many exported
   * patient rows is emitted against a subject the corpus does not know, so the
   * quarantine path is exercised by the pinned corpus rather than only by a
   * unit test. The acquired-clinic export that imports cleanly is the fiction.
   */
  orphanRowEveryN: 11,
} as const;

export function generateSynthCorpus(spec: SynthCorpusSpec, runner: SyntheaRunnerPort): SynthCorpus {
  const clock = createSimulatedClock(spec.simulatedClockEpoch);
  const world = generateIdentityWorld({
    tenantId: spec.tenantId,
    masterSeed: spec.masterSeed,
    clock,
    householdCount: spec.householdCount,
    personaAssignments: spec.personaAssignments,
    locations: spec.locations,
  });

  if (world.subjects.length < spec.personaAssignments.length) {
    throw new Error(
      `generateSynthCorpus: ${world.subjects.length} subjects cannot cover ` +
        `${spec.personaAssignments.length} personas — raise householdCount`,
    );
  }

  for (const collision of world.collisions) {
    if (
      overlapIsMergeSufficient(collision.sharedAttributeNames) !== collision.mergeSufficientOverlap
    ) {
      throw new Error(
        `generateSynthCorpus: collision ${collision.collisionId} records ` +
          `mergeSufficientOverlap=${String(collision.mergeSufficientOverlap)} but its overlap ` +
          'recomputes to the opposite — known truth must be derivable, never asserted',
      );
    }
  }

  const subjectRefs = world.subjects.map((subject) => subject.subjectId);
  const exported = runner.run({
    seed: spec.masterSeed,
    populationSize: subjectRefs.length,
    subjectRefs,
    simulatedClockEpoch: spec.simulatedClockEpoch,
    synthetic: true,
  });

  const imported = importSyntheaExport(exported, subjectRefs, {
    conditions: conditionCatalog.map((entry) => entry.code),
    medications: medicationCatalog.map((entry) => entry.code),
  });

  const coverageSubjects: CoverageSubject[] = world.subjects.map((subject) => ({
    subjectId: subject.subjectId,
    personaSlug: subject.personaSlug,
    journeys: subject.journeys,
  }));

  const sideEffects: CorpusSideEffect[] = [
    ...world.households.map((household) =>
      buildCorpusSideEffect(spec.corpusVersion, 'corpus-household-seeded', household.householdId),
    ),
    ...world.subjects.map((subject) =>
      buildCorpusSideEffect(spec.corpusVersion, 'corpus-subject-seeded', subject.subjectId),
    ),
  ];

  const personaSlugs = new Set(spec.personaAssignments.map((assignment) => assignment.slug));
  const journeys = new Set(spec.personaAssignments.flatMap((assignment) => assignment.journeys));

  return {
    synthetic: true,
    corpus_version: spec.corpusVersion,
    recovery_epoch: spec.recoveryEpoch,
    simulated_clock_epoch: spec.simulatedClockEpoch,
    master_seed: spec.masterSeed,
    generator: spec.generator,
    tenant_id: spec.tenantId,
    source_register: sourceRegisterV1,
    households: world.households,
    subjects: world.subjects,
    collisions: world.collisions,
    clinical_backbone: imported.backbone,
    import_quarantine: imported.quarantine,
    side_effects: sideEffects,
    coverage: {
      personas_required: personaSlugs.size,
      personas_covered: new Set(coverageSubjects.map((subject) => subject.personaSlug)).size,
      journeys_required: journeys.size,
      journeys_covered: new Set(coverageSubjects.flatMap((subject) => subject.journeys)).size,
    },
  };
}

/** Byte-stable serialization: 2-space JSON with a trailing newline, LF only. */
export function serializeSynthCorpus(corpus: SynthCorpus): string {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk every node. Two rules, both fail-closed:
 * - a node carrying a `synthetic` key must carry exactly `true`;
 * - every element of a declared record collection must carry the key at all.
 */
export function assertCorpusBootWatermark(value: unknown, path = 'corpus'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertCorpusBootWatermark(entry, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if ('synthetic' in value && value.synthetic !== true) {
    throw new Error(
      `${path}.synthetic is ${JSON.stringify(value.synthetic)} — the corpus refuses to boot ` +
        'unwatermarked data',
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    assertCorpusBootWatermark(entry, `${path}.${key}`);
  }
}

const watermarkedCollections = [
  'households',
  'subjects',
  'collisions',
  'clinical_backbone',
  'import_quarantine',
  'side_effects',
] as const;

export function assertCorpusRecordsWatermarked(corpus: SynthCorpus): void {
  if (corpus.synthetic !== true) {
    throw new Error(
      'corpus.synthetic must be exactly true — the corpus refuses to boot unwatermarked data',
    );
  }
  const asRecord = corpus as unknown as Record<string, unknown>;
  for (const collection of watermarkedCollections) {
    const entries = asRecord[collection];
    if (!Array.isArray(entries)) {
      throw new Error(`corpus.${collection} must be an array of watermarked records`);
    }
    entries.forEach((entry, index) => {
      if (!isRecord(entry) || !('synthetic' in entry)) {
        throw new Error(
          `corpus.${collection}[${index}] carries no synthetic watermark at all — ` +
            'a record without the key is refused as firmly as one with it set false',
        );
      }
    });
  }
  assertCorpusBootWatermark(corpus);
}

export function parseSynthCorpus(text: string): SynthCorpus {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`synthgen corpus is not valid JSON: ${String(error)}`, { cause: error });
  }
  if (!isRecord(raw)) {
    throw new Error('synthgen corpus must be a JSON object');
  }
  const corpus = raw as unknown as SynthCorpus;
  assertCorpusRecordsWatermarked(corpus);
  return corpus;
}

/** The boot path: read, parse, and assert the watermark before anything else. */
export function loadSynthCorpus(filePath: string): SynthCorpus {
  return parseSynthCorpus(readFileSync(filePath, 'utf8'));
}

export { evaluatePersonaStoryCoverage };
