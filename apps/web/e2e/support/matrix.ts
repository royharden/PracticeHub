import { readFileSync } from 'node:fs';

import {
  parseCsv,
  parsePersonaStoryMatrix,
  records,
  type PersonaStoryRow,
} from '@practicehub/testkit';

import { corpusCovers, loadSynthCorpus, type SynthCorpus } from './corpus.js';
import {
  approvedDependencyOwners,
  categoryRequirementFamilies,
  journeyRegistry,
  requiredParityOwners,
} from './journey-plan.js';

export interface JourneyTestBinding {
  readonly rowKey: string;
  readonly testId: string;
  readonly contractId: string;
}

export interface DependencyBinding {
  readonly category: string;
  readonly wpId: string;
  readonly reason: string;
  readonly excludeRowKeys?: readonly string[];
}

export interface ParityGate {
  readonly contractId: string;
  readonly wpId: string;
  readonly status: 'blocked' | 'ready';
  readonly reason: string;
  readonly normalizedParity?: 'passed';
}

export interface JourneyBindings {
  readonly schemaVersion: 1;
  readonly matrixContract: 'persona-story-matrix/v1';
  readonly corpusVersion: 'SynthCorpus-v1';
  readonly journeyTests: readonly JourneyTestBinding[];
  readonly categoryDependencies: readonly DependencyBinding[];
  readonly parityGates: readonly ParityGate[];
}

export interface CoverageSummary {
  readonly rows: number;
  readonly personas: number;
  readonly namedJourneys: number;
  readonly journeyTestRows: number;
  readonly dependencyRows: number;
  readonly fixtureClasses: 4;
}

export interface CoverageInput {
  readonly rows: readonly PersonaStoryRow[];
  readonly bindings: JourneyBindings;
  readonly corpus: SynthCorpus;
  readonly workPackages: ReadonlyMap<string, ReadonlySet<string>>;
  readonly journeyRegistry: readonly JourneyTestBinding[];
}

export function matrixRowKey(row: PersonaStoryRow): string {
  return [row.canonicalId, row.personaSlug, row.journey].join('|');
}

export function loadJourneyBindings(): JourneyBindings {
  const path = new URL('../journey-bindings.v1.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as JourneyBindings;
}

export function loadMatrix(): PersonaStoryRow[] {
  const path = new URL('../../../../docs/requirements/persona-story-matrix.csv', import.meta.url);
  return parsePersonaStoryMatrix(readFileSync(path, 'utf8'));
}

export function loadWorkPackages(): ReadonlyMap<string, ReadonlySet<string>> {
  const path = new URL('../../../../planning/work-packages.csv', import.meta.url);
  const parsed = records(parseCsv(readFileSync(path, 'utf8')));
  return new Map(
    parsed
      .filter((row) => /^WP-\d{3}$/.test(row['wp_id'] ?? ''))
      .map((row) => [
        row['wp_id'] ?? '',
        new Set((row['req_ids'] ?? '').split(';').filter(Boolean)),
      ]),
  );
}

function fail(errors: readonly string[]): never {
  throw new Error('WP-035 journey coverage invalid:\n- ' + errors.join('\n- '));
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort().join(',');
  return actual === [...keys].sort().join(',');
}

export function validateCoverage(input: CoverageInput): CoverageSummary {
  const errors: string[] = [];
  const rowKeys = input.rows.map(matrixRowKey);
  const rowKeySet = new Set(rowKeys);
  if (
    input.bindings.schemaVersion !== 1 ||
    input.bindings.matrixContract !== 'persona-story-matrix/v1'
  ) {
    errors.push('binding schema/matrix contract drift');
  }
  if (input.bindings.corpusVersion !== input.corpus.corpus_version) {
    errors.push('binding/corpus version drift');
  }
  if (input.rows.length !== 789) {
    errors.push('expected 789 canonical matrix rows, found ' + input.rows.length);
  }
  if (rowKeySet.size !== rowKeys.length) {
    errors.push('canonical matrix contains duplicate row keys');
  }

  const testRuleKeys = new Set<string>();
  const testIds = new Set<string>();
  const contractIds = new Set<string>();
  const registryTuples = new Set(
    input.journeyRegistry.map(
      (binding) => binding.rowKey + '\t' + binding.testId + '\t' + binding.contractId,
    ),
  );
  for (const binding of input.bindings.journeyTests) {
    if (testRuleKeys.has(binding.rowKey))
      errors.push('duplicate journey-test binding: ' + binding.rowKey);
    testRuleKeys.add(binding.rowKey);
    if (!rowKeySet.has(binding.rowKey)) errors.push('stale journey-test row: ' + binding.rowKey);
    if (testIds.has(binding.testId)) errors.push('journey test reused: ' + binding.testId);
    if (contractIds.has(binding.contractId))
      errors.push('journey contract reused: ' + binding.contractId);
    testIds.add(binding.testId);
    contractIds.add(binding.contractId);
    const tuple = binding.rowKey + '\t' + binding.testId + '\t' + binding.contractId;
    if (!registryTuples.has(tuple)) errors.push('journey registry tuple mismatch: ' + tuple);
  }
  for (const registryBinding of input.journeyRegistry) {
    const matches = input.bindings.journeyTests.filter(
      (binding) =>
        binding.rowKey === registryBinding.rowKey &&
        binding.testId === registryBinding.testId &&
        binding.contractId === registryBinding.contractId,
    );
    if (matches.length !== 1) {
      errors.push('orphan or duplicate journey registry tuple: ' + registryBinding.testId);
    }
  }

  const dependencyCategories = new Set<string>();
  for (const binding of input.bindings.categoryDependencies) {
    if (dependencyCategories.has(binding.category)) {
      errors.push('duplicate dependency category: ' + binding.category);
    }
    dependencyCategories.add(binding.category);
    const expectedOwner = approvedDependencyOwners[binding.category];
    const requirementFamily = categoryRequirementFamilies[binding.category];
    const packageFamilies = input.workPackages.get(binding.wpId);
    if (binding.wpId !== expectedOwner) {
      errors.push(
        'unapproved dependency owner for ' +
          binding.category +
          ': expected ' +
          String(expectedOwner) +
          ', found ' +
          binding.wpId,
      );
    }
    if (!packageFamilies || !requirementFamily || !packageFamilies.has(requirementFamily)) {
      errors.push('dependency owner lacks canonical requirement family: ' + binding.category);
    }
    if (binding.reason.trim().length === 0 || /\b(?:TBD|future)\b/i.test(binding.reason)) {
      errors.push('non-explicit dependency reason: ' + binding.category);
    }
    const exclusions = new Set(binding.excludeRowKeys ?? []);
    for (const excluded of exclusions) {
      if (!rowKeySet.has(excluded)) errors.push('stale dependency exclusion: ' + excluded);
    }
    const matches = input.rows.filter(
      (row) => row.category === binding.category && !exclusions.has(matrixRowKey(row)),
    );
    if (matches.length === 0) errors.push('stale dependency selector: ' + binding.category);
  }

  let journeyTestRows = 0;
  let dependencyRows = 0;
  for (const row of input.rows) {
    const key = matrixRowKey(row);
    const testMatches = input.bindings.journeyTests.filter((binding) => binding.rowKey === key);
    const dependencyMatches = input.bindings.categoryDependencies.filter(
      (binding) =>
        binding.category === row.category && !(binding.excludeRowKeys ?? []).includes(key),
    );
    const matches = testMatches.length + dependencyMatches.length;
    if (matches !== 1) errors.push(key + ' resolves ' + matches + ' times');
    journeyTestRows += testMatches.length;
    dependencyRows += dependencyMatches.length;
    const required = new Set<string>(row.requiredFixtureClasses);
    for (const fixtureClass of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
      if (!required.has(fixtureClass)) {
        errors.push(key + ' missing fixture class ' + fixtureClass);
      }
    }
    if (!corpusCovers(input.corpus, row.personaSlug, row.journey)) {
      errors.push('corpus lacks matrix row: ' + key);
    }
  }

  const parityIds = new Set<string>();
  for (const gate of input.bindings.parityGates) {
    const rawGate = gate as unknown as Record<string, unknown>;
    if (parityIds.has(gate.contractId)) errors.push('duplicate parity gate: ' + gate.contractId);
    parityIds.add(gate.contractId);
    if (gate.status !== 'blocked' && gate.status !== 'ready') {
      errors.push('unsupported parity status: ' + String(gate.status));
    }
    const expectedKeys =
      gate.status === 'ready'
        ? ['contractId', 'wpId', 'status', 'reason', 'normalizedParity']
        : ['contractId', 'wpId', 'status', 'reason'];
    if (!hasExactKeys(rawGate, expectedKeys)) {
      errors.push('parity gate shape mismatch: ' + gate.contractId);
    }
    if (gate.reason.trim().length === 0)
      errors.push('parity gate lacks reason: ' + gate.contractId);
    if (requiredParityOwners[gate.contractId] !== gate.wpId) {
      errors.push('invalid parity owner: ' + gate.contractId);
    }
    if (gate.status === 'ready' && gate.normalizedParity !== 'passed') {
      errors.push('ready parity gate lacks normalized evidence: ' + gate.contractId);
    }
  }
  for (const [contractId, wpId] of Object.entries(requiredParityOwners)) {
    const matches = input.bindings.parityGates.filter(
      (gate) => gate.contractId === contractId && gate.wpId === wpId,
    );
    if (matches.length !== 1)
      errors.push('missing or duplicate required parity gate: ' + contractId);
  }
  if (errors.length > 0) fail(errors);
  return {
    rows: input.rows.length,
    personas: new Set(input.rows.map((row) => row.personaSlug)).size,
    namedJourneys: new Set(input.rows.map((row) => row.journey).filter(Boolean)).size,
    journeyTestRows,
    dependencyRows,
    fixtureClasses: 4,
  };
}

export function validateCanonicalCoverage(): CoverageSummary {
  return validateCoverage({
    rows: loadMatrix(),
    bindings: loadJourneyBindings(),
    corpus: loadSynthCorpus(),
    workPackages: loadWorkPackages(),
    journeyRegistry,
  });
}
