import { expect, test } from '@playwright/test';
import type { PersonaStoryRow } from '@practicehub/testkit';

import type { SynthCorpus } from './support/corpus.js';
import {
  type CoverageInput,
  type JourneyBindings,
  loadJourneyBindings,
  loadMatrix,
  loadWorkPackages,
  validateCoverage,
} from './support/matrix.js';
import { loadSynthCorpus } from './support/corpus.js';
import { journeyRegistry } from './support/journey-plan.js';

function canonicalInput(): CoverageInput {
  return {
    rows: loadMatrix(),
    bindings: loadJourneyBindings(),
    corpus: loadSynthCorpus(),
    workPackages: loadWorkPackages(),
    journeyRegistry,
  };
}

function cloneBindings(bindings: JourneyBindings): JourneyBindings {
  return structuredClone(bindings);
}

function firstOrThrow<T>(values: readonly T[], label: string): T {
  const first = values[0];
  if (first === undefined) throw new Error(label + ' unexpectedly empty');
  return first;
}

test('canonical matrix resolves once without becoming a second truth', () => {
  const summary = validateCoverage(canonicalInput());
  expect(summary).toEqual({
    rows: 789,
    personas: 43,
    namedJourneys: 419,
    journeyTestRows: 3,
    dependencyRows: 786,
    fixtureClasses: 4,
  });
});

test('mutation: missing binding is rejected', () => {
  const input = canonicalInput();
  const bindings = cloneBindings(input.bindings);
  const journeyTests = bindings.journeyTests.slice(1);
  expect(() => validateCoverage({ ...input, bindings: { ...bindings, journeyTests } })).toThrow(
    /resolves 0 times/,
  );
});

test('mutation: duplicate binding is rejected', () => {
  const input = canonicalInput();
  const bindings = cloneBindings(input.bindings);
  const journeyTests = [
    ...bindings.journeyTests,
    firstOrThrow(bindings.journeyTests, 'journey tests'),
  ];
  expect(() => validateCoverage({ ...input, bindings: { ...bindings, journeyTests } })).toThrow(
    /duplicate journey-test binding|resolves 2 times/,
  );
});

test('mutation: stale selector is rejected', () => {
  const input = canonicalInput();
  const bindings = cloneBindings(input.bindings);
  const categoryDependencies = [
    ...bindings.categoryDependencies,
    { category: 'not-a-category', wpId: 'WP-035', reason: 'Explicit mutation probe.' },
  ];
  expect(() =>
    validateCoverage({ ...input, bindings: { ...bindings, categoryDependencies } }),
  ).toThrow(/stale dependency selector/);
});

test('mutation: absent journey test ID is rejected', () => {
  const input = canonicalInput();
  expect(() => validateCoverage({ ...input, journeyRegistry: [] })).toThrow(
    /journey registry tuple mismatch/,
  );
});

test('mutation: invalid package dependency is rejected', () => {
  const input = canonicalInput();
  const bindings = cloneBindings(input.bindings);
  const categoryDependencies = bindings.categoryDependencies.map((binding, index) =>
    index === 0 ? { ...binding, wpId: 'WP-999' } : binding,
  );
  expect(() =>
    validateCoverage({ ...input, bindings: { ...bindings, categoryDependencies } }),
  ).toThrow(/unapproved dependency owner|canonical requirement family/);
});

test('mutation: wrong known row/test/contract pairing is rejected', () => {
  const input = canonicalInput();
  const bindings = cloneBindings(input.bindings);
  const first = firstOrThrow(bindings.journeyTests, 'journey tests');
  const second = bindings.journeyTests[1];
  if (!second) throw new Error('journey tests lacks second item');
  const journeyTests = [
    { ...first, contractId: second.contractId },
    ...bindings.journeyTests.slice(1),
  ];
  expect(() => validateCoverage({ ...input, bindings: { ...bindings, journeyTests } })).toThrow(
    /journey registry tuple mismatch/,
  );
});

test('mutation: reusing one known test for all rows is rejected', () => {
  const input = canonicalInput();
  const bindings = cloneBindings(input.bindings);
  const first = firstOrThrow(bindings.journeyTests, 'journey tests');
  const journeyTests = bindings.journeyTests.map((binding) => ({
    ...binding,
    testId: first.testId,
  }));
  expect(() => validateCoverage({ ...input, bindings: { ...bindings, journeyTests } })).toThrow(
    /journey test reused|journey registry tuple mismatch/,
  );
});

test('mutation: orphan executable journey is rejected', () => {
  const input = canonicalInput();
  const orphan = {
    rowKey: input.journeyRegistry[0]?.rowKey ?? 'missing',
    testId: 'journey:orphan',
    contractId: 'orphan-page/v1',
  };
  expect(() =>
    validateCoverage({ ...input, journeyRegistry: [...input.journeyRegistry, orphan] }),
  ).toThrow(/orphan or duplicate journey registry tuple/);
});

test('mutation: missing parity gates are rejected', () => {
  const input = canonicalInput();
  const bindings = { ...cloneBindings(input.bindings), parityGates: [] };
  expect(() => validateCoverage({ ...input, bindings })).toThrow(
    /missing or duplicate required parity gate/,
  );
});

test('mutation: duplicate parity gate is rejected', () => {
  const input = canonicalInput();
  const cloned = cloneBindings(input.bindings);
  const parityGates = [...cloned.parityGates, firstOrThrow(cloned.parityGates, 'parity gates')];
  expect(() => validateCoverage({ ...input, bindings: { ...cloned, parityGates } })).toThrow(
    /duplicate parity gate/,
  );
});

for (const invalidStatus of ['banana', null]) {
  test('mutation: unsupported parity status is rejected: ' + String(invalidStatus), () => {
    const input = canonicalInput();
    const cloned = cloneBindings(input.bindings);
    const first = firstOrThrow(cloned.parityGates, 'parity gates');
    const parityGates = [
      { ...first, status: invalidStatus },
      ...cloned.parityGates.slice(1),
    ] as unknown as JourneyBindings['parityGates'];
    expect(() => validateCoverage({ ...input, bindings: { ...cloned, parityGates } })).toThrow(
      /unsupported parity status|parity gate shape mismatch/,
    );
  });
}

test('mutation: missing fixture class is rejected', () => {
  const input = canonicalInput();
  const first = firstOrThrow(input.rows, 'matrix rows');
  const rows: PersonaStoryRow[] = [
    { ...first, requiredFixtureClasses: first.requiredFixtureClasses.slice(0, 3) },
    ...input.rows.slice(1),
  ];
  expect(() => validateCoverage({ ...input, rows })).toThrow(/missing fixture class/);
});

test('mutation: unknown corpus identity is rejected', () => {
  const input = canonicalInput();
  const personaSlug = firstOrThrow(input.rows, 'matrix rows').personaSlug;
  const corpus: SynthCorpus = {
    ...input.corpus,
    subjects: input.corpus.subjects.filter((subject) => subject.personaSlug !== personaSlug),
  };
  expect(() => validateCoverage({ ...input, corpus })).toThrow(/corpus lacks matrix row/);
});

test('mutation: corpus version drift is rejected', () => {
  const input = canonicalInput();
  const bindings = {
    ...cloneBindings(input.bindings),
    corpusVersion: 'SynthCorpus-v2',
  } as unknown as JourneyBindings;
  expect(() => validateCoverage({ ...input, bindings })).toThrow(/version drift/);
});
