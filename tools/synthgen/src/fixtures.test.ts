/**
 * Four-class fixture packs for the corpus domains (WP-029).
 *
 * WP-029 owns no canonical requirement end-to-end — the REQ-MIG family
 * completes in the M5 migration-workbench packages, and the frozen contract §8
 * routes every member to its owner. The four-class floor is therefore carried
 * per corpus DOMAIN, the WP-027 per-rail substitution: identity/household
 * synthesis, Synthea import, persona x story coverage, and checkpoint replay
 * each get HAPPY/BOUNDARY/FAILURE/RECOVERY.
 *
 * Harness discipline (review-009): every op is validated at LOAD time against
 * the closed vocabulary, and the dispatcher's `default` THROWS — a fixture
 * naming an op nobody implements fails loudly instead of passing vacuously.
 * Every case runs against the real domain functions, never a restatement.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { computeManifestCheckpoint } from '@practicehub/testkit';
import type { PersonaStoryRow } from '@practicehub/testkit';

import { createSimulatedClock } from './clock.js';
import { evaluatePersonaStoryCoverage, personaStoryCoverageErrors } from './coverage.js';
import { buildCorpusSideEffect, planCorpusReplay, type ReplayLedgerEntry } from './epoch.js';
import { generateIdentityWorld, overlapIsMergeSufficient } from './identity.js';
import {
  assertObservedAttributeNames,
  importSyntheaExport,
  type SyntheaExport,
} from './synthea.js';
import { conditionCatalog, medicationCatalog } from './vocab.js';

const fixtureClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;
const domains = [
  'CORPUS-IDENTITY',
  'CORPUS-SYNTHEA-IMPORT',
  'CORPUS-COVERAGE',
  'CORPUS-REPLAY',
] as const;

const knownOps = new Set([
  'household-shares-endpoints',
  'world-covers-personas',
  'collision-endpoint-only-never-merge-sufficient',
  'collision-truth-derivable',
  'import-maps-known-subjects',
  'import-quarantines-orphan',
  'import-refuses-unwatermarked-export',
  'import-quarantine-refuses-value-as-name',
  'coverage-complete',
  'coverage-rejects-lowered-floor',
  'coverage-names-missing-persona',
  'coverage-names-missing-journey',
  'replay-fences-landed-effects',
  'replay-across-epoch-boundary',
  'replay-refuses-unfenced-checkpoint',
  'replay-resends-never-emitted-effect',
]);

interface FixtureCase {
  readonly name: string;
  readonly op: string;
  readonly input: Record<string, unknown>;
  readonly expect: Record<string, unknown>;
}

interface FixturePack {
  readonly synthetic: true;
  readonly domain: string;
  readonly fixtureClass: string;
  readonly cases: readonly FixtureCase[];
}

const fixturesDir = resolve(import.meta.dirname, '../fixtures');

function loadPack(domain: string, fixtureClass: string): FixturePack {
  const path = resolve(fixturesDir, `${domain}.${fixtureClass}.json`);
  const pack = JSON.parse(readFileSync(path, 'utf8')) as FixturePack;
  if (pack.synthetic !== true) {
    throw new Error(`${domain}.${fixtureClass} lacks the synthetic watermark`);
  }
  if (pack.cases.length === 0) {
    throw new Error(`${domain}.${fixtureClass} declares no cases`);
  }
  // LOAD-TIME op validation: an unknown op never reaches the dispatcher.
  for (const testCase of pack.cases) {
    if (!knownOps.has(testCase.op)) {
      throw new Error(
        `${domain}.${fixtureClass} case "${testCase.name}" names unknown op "${testCase.op}"`,
      );
    }
  }
  return pack;
}

const clock = createSimulatedClock('2026-01-01T00:00:00Z');
const locations = [
  { locationId: 'northwind-nv-henderson', legalEntityId: 'northwind-health-nv', stateCode: 'NV' },
  {
    locationId: 'northwind-fl-coral-gables',
    legalEntityId: 'northwind-health-fl',
    stateCode: 'FL',
  },
];

function personaAssignments(slugs: readonly string[]) {
  return slugs.map((slug) => ({ slug, personaClass: 'staff', journeys: [`${slug}-journey`] }));
}

function worldFor(input: Record<string, unknown>) {
  const slugs = (input.personaSlugs as string[] | undefined) ?? [
    'prospective-patient',
    'data-migration-engineer',
  ];
  return generateIdentityWorld({
    tenantId: 'northwind-synthetic',
    masterSeed: String(input.masterSeed),
    clock,
    householdCount: Number(input.householdCount),
    personaAssignments: personaAssignments(slugs),
    locations,
  });
}

function syntheaExport(subjectRefs: readonly string[], orphanEveryN: number): SyntheaExport {
  const conditions = subjectRefs.map((subjectRef) => ({
    subjectRef,
    code: 'SYN-COND-001',
    description: 'c',
    onsetDate: '2020-01-01',
  }));
  if (orphanEveryN > 0) {
    conditions.push({
      subjectRef: 'sy-orphan-1',
      code: 'SYN-COND-001',
      description: 'c',
      onsetDate: '2020-01-01',
    });
  }
  return {
    generator: { name: 'fixture-runner', version: 'v0' },
    seed: 'fixture',
    patients: subjectRefs.map((subjectRef) => ({
      subjectRef,
      birthDate: '1990-01-01',
      residenceState: 'NV',
      city: 'Ridgeline',
    })),
    conditions,
    medications: [],
    encounters: [],
    synthetic: true,
  };
}

const permittedCodes = {
  conditions: conditionCatalog.map((entry) => entry.code),
  medications: medicationCatalog.map((entry) => entry.code),
};

function matrixRow(personaSlug: string, journey: string, classes?: string[]): PersonaStoryRow {
  return {
    canonicalId: 'REQ-MIG-005',
    category: 'migration',
    persona: personaSlug,
    personaSlug,
    personaClass: 'staff',
    journey,
    requiredFixtureClasses: (classes ?? ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY']) as never,
  };
}

function replayManifest(epoch: string, tamper?: { field: string; value: string }) {
  const base: Record<string, unknown> = {
    synthetic: true,
    corpus_version: 'SynthCorpus-v1',
    recovery_epoch: epoch,
  };
  const fenced = { ...base, manifest_checkpoint: computeManifestCheckpoint(base) };
  return tamper ? { ...fenced, [tamper.field]: tamper.value } : fenced;
}

function replayEffects(entityRefs: readonly string[]) {
  return entityRefs.map((ref) =>
    buildCorpusSideEffect(
      'SynthCorpus-v1',
      ref.startsWith('sg-hh-') ? 'corpus-household-seeded' : 'corpus-subject-seeded',
      ref,
    ),
  );
}

function runCase(testCase: FixtureCase): void {
  const { input, expect: expected } = testCase;
  switch (testCase.op) {
    case 'household-shares-endpoints': {
      const world = worldFor(input);
      const multi = world.households.filter((house) => house.memberSubjectIds.length > 1);
      expect(multi.length).toBeGreaterThanOrEqual(Number(expected.minMultiMemberHouseholds));
      for (const household of multi) {
        const members = household.memberSubjectIds.map((id) =>
          world.subjects.find((subject) => subject.subjectId === id),
        );
        const phones = new Set(
          members.flatMap((member) =>
            (member?.endpoints ?? [])
              .filter((endpoint) => endpoint.kind === 'phone')
              .map((endpoint) => endpoint.endpointId),
          ),
        );
        const emails = new Set(
          members.flatMap((member) =>
            (member?.endpoints ?? [])
              .filter((endpoint) => endpoint.kind === 'email')
              .map((endpoint) => endpoint.endpointId),
          ),
        );
        expect(phones.size).toBe(Number(expected.distinctPhoneIdsPerHousehold));
        expect(emails.size).toBe(Number(expected.distinctEmailIdsPerHousehold));
      }
      return;
    }
    case 'world-covers-personas': {
      const world = worldFor(input);
      const covered = new Set(world.subjects.map((subject) => subject.personaSlug));
      const slugs = input.personaSlugs as string[];
      expect(slugs.every((slug) => covered.has(slug))).toBe(expected.allPersonasCovered);
      return;
    }
    case 'collision-endpoint-only-never-merge-sufficient': {
      expect(overlapIsMergeSufficient(input.sharedAttributeNames as string[])).toBe(
        expected.mergeSufficient,
      );
      return;
    }
    case 'collision-truth-derivable': {
      const world = worldFor(input);
      for (const collision of world.collisions) {
        expect(overlapIsMergeSufficient(collision.sharedAttributeNames)).toBe(
          collision.mergeSufficientOverlap,
        );
      }
      expect(
        world.collisions.filter((c) => c.knownTruth === 'same-person').length,
      ).toBeGreaterThanOrEqual(Number(expected.minSamePersonPairs));
      expect(
        world.collisions.filter((c) => c.knownTruth === 'distinct-person').length,
      ).toBeGreaterThanOrEqual(Number(expected.minDistinctPersonPairs));
      return;
    }
    case 'import-maps-known-subjects': {
      const refs = input.subjectRefs as string[];
      const result = importSyntheaExport(
        syntheaExport(refs, Number(input.orphanRowEveryN)),
        refs,
        permittedCodes,
      );
      expect(result.backbone).toHaveLength(Number(expected.backboneCount));
      expect(result.quarantine).toHaveLength(Number(expected.quarantineCount));
      return;
    }
    case 'import-quarantines-orphan': {
      const refs = input.subjectRefs as string[];
      const result = importSyntheaExport(
        syntheaExport(refs, Number(input.orphanRowEveryN)),
        refs,
        permittedCodes,
      );
      expect(result.quarantine.length).toBeGreaterThanOrEqual(Number(expected.minQuarantine));
      expect(result.quarantine[0]?.reason).toBe(expected.reason);
      expect(result.quarantine[0]?.observedAttributeNames).toEqual(expected.observedAttributeNames);
      return;
    }
    case 'import-refuses-unwatermarked-export': {
      const refs = input.subjectRefs as string[];
      const unwatermarked = {
        ...syntheaExport(refs, 0),
        synthetic: false,
      } as unknown as SyntheaExport;
      expect(() => importSyntheaExport(unwatermarked, refs, permittedCodes)).toThrow(
        new RegExp(String(expected.throwsMatching)),
      );
      return;
    }
    case 'import-quarantine-refuses-value-as-name': {
      const names = input.observedAttributeNames as string[];
      if (expected.throwsMatching === null) {
        expect(() => {
          assertObservedAttributeNames(names);
        }).not.toThrow();
      } else {
        expect(() => {
          assertObservedAttributeNames(names);
        }).toThrow(new RegExp(String(expected.throwsMatching)));
      }
      return;
    }
    case 'coverage-complete':
    case 'coverage-names-missing-persona':
    case 'coverage-names-missing-journey': {
      const rows = (input.rows as { personaSlug: string; journey: string }[]).map((row) =>
        matrixRow(row.personaSlug, row.journey),
      );
      const subjects = (input.subjects as { personaSlug: string; journeys: string[] }[]).map(
        (subject, index) => ({ subjectId: `sg-p-${String(index)}`, ...subject }),
      );
      const report = evaluatePersonaStoryCoverage(rows, subjects);
      const errors = personaStoryCoverageErrors(report);
      if (expected.errorCount !== undefined) {
        expect(errors).toHaveLength(Number(expected.errorCount));
      }
      if (expected.missingPersonaSlugs !== undefined) {
        expect(report.missingPersonaSlugs).toEqual(expected.missingPersonaSlugs);
      }
      if (expected.missingJourneys !== undefined) {
        expect(report.missingJourneys).toEqual(expected.missingJourneys);
      }
      if (typeof expected.mentions === 'string') {
        expect(errors.some((message) => message.includes(expected.mentions as string))).toBe(true);
      }
      return;
    }
    case 'coverage-rejects-lowered-floor': {
      const row = matrixRow(
        'data-migration-engineer',
        'clinic-acquisition-onboarding',
        input.requiredFixtureClasses as string[],
      );
      const report = evaluatePersonaStoryCoverage(
        [row],
        [
          {
            subjectId: 'sg-p-0001',
            personaSlug: 'data-migration-engineer',
            journeys: ['clinic-acquisition-onboarding'],
          },
        ],
      );
      expect(report.rowsBelowFloor).toHaveLength(Number(expected.belowFloorCount));
      if (typeof expected.mentions === 'string') {
        expect(report.rowsBelowFloor[0]).toContain(expected.mentions);
      }
      return;
    }
    case 'replay-fences-landed-effects':
    case 'replay-across-epoch-boundary': {
      const effects = replayEffects(input.entityRefs as string[]);
      const entry: ReplayLedgerEntry = {
        delivery: { status: input.deliveryStatus as never, attempts: 1 },
        alreadyConsumed: Boolean(input.alreadyConsumed),
      };
      const ledger = new Map(effects.map((effect) => [effect.idempotencyKey, entry]));
      const plan = planCorpusReplay(
        replayManifest(String(input.manifestEpoch)),
        String(input.replayEpoch),
        effects,
        ledger,
      );
      expect(plan.resend).toHaveLength(Number(expected.resendCount));
      expect(plan.fenced).toHaveLength(Number(expected.fencedCount));
      return;
    }
    case 'replay-refuses-unfenced-checkpoint': {
      const effects = replayEffects(input.entityRefs as string[]);
      const tampered = replayManifest('RE-001', {
        field: String(input.tamperField),
        value: String(input.tamperValue),
      });
      expect(() => planCorpusReplay(tampered, 'RE-001', effects, new Map())).toThrow(
        new RegExp(String(expected.throwsMatching)),
      );
      return;
    }
    case 'replay-resends-never-emitted-effect': {
      const effects = replayEffects(input.entityRefs as string[]);
      const ledger = new Map<string, ReplayLedgerEntry>();
      if (input.ledgerEmpty !== true) {
        for (const effect of effects) {
          ledger.set(effect.idempotencyKey, {
            delivery: { status: input.deliveryStatus as never, attempts: 0 },
            alreadyConsumed: Boolean(input.alreadyConsumed),
          });
        }
      }
      const plan = planCorpusReplay(replayManifest('RE-001'), 'RE-001', effects, ledger);
      expect(plan.resend).toHaveLength(Number(expected.resendCount));
      expect(plan.fenced).toHaveLength(Number(expected.fencedCount));
      return;
    }
    default:
      // A fixture op that reaches here is unimplemented; never pass silently.
      throw new Error(`fixture harness has no implementation for op "${testCase.op}"`);
  }
}

describe('WP-029 corpus fixture packs', () => {
  it('carries the full four-class floor for every corpus domain', () => {
    for (const domain of domains) {
      for (const fixtureClass of fixtureClasses) {
        expect(() => loadPack(domain, fixtureClass)).not.toThrow();
      }
    }
  });

  it('rejects a pack naming an op nobody implements (load-time validation bites)', () => {
    const pack: FixturePack = {
      synthetic: true,
      domain: 'CORPUS-IDENTITY',
      fixtureClass: 'HAPPY',
      cases: [{ name: 'planted', op: 'frobnicate', input: {}, expect: {} }],
    };
    for (const testCase of pack.cases) {
      expect(knownOps.has(testCase.op)).toBe(false);
    }
    expect(() => {
      runCase(pack.cases[0] as FixtureCase);
    }).toThrow(/no implementation for op/);
  });

  for (const domain of domains) {
    for (const fixtureClass of fixtureClasses) {
      const pack = loadPack(domain, fixtureClass);
      describe(`${domain} / ${fixtureClass}`, () => {
        for (const testCase of pack.cases) {
          it(testCase.name, () => {
            runCase(testCase);
          });
        }
      });
    }
  }
});
