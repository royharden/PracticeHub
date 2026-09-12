import { readFileSync } from 'node:fs';

import type { CorpusReference } from '../contracts/v1/types.js';

interface CorpusSubject {
  readonly subjectId: string;
  readonly personaSlug: string;
  readonly journeys: readonly string[];
  readonly synthetic: true;
}

export interface SynthCorpus {
  readonly synthetic: true;
  readonly corpus_version: 'SynthCorpus-v1';
  readonly simulated_clock_epoch: '2026-01-01T00:00:00Z';
  readonly tenant_id: 'northwind-synthetic';
  readonly subjects: readonly CorpusSubject[];
  readonly coverage: {
    readonly personas_required: 43;
    readonly personas_covered: 43;
    readonly journeys_required: 419;
    readonly journeys_covered: 419;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadSynthCorpus(): SynthCorpus {
  const path = new URL('../../../../synthetic-corpus/synthgen-corpus.v1.json', import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !isRecord(raw) ||
    raw['synthetic'] !== true ||
    raw['corpus_version'] !== 'SynthCorpus-v1' ||
    raw['simulated_clock_epoch'] !== '2026-01-01T00:00:00Z' ||
    raw['tenant_id'] !== 'northwind-synthetic' ||
    !Array.isArray(raw['subjects']) ||
    !isRecord(raw['coverage'])
  ) {
    throw new Error('WP-029 corpus identity/version drift');
  }
  const coverage = raw['coverage'];
  if (
    coverage['personas_required'] !== 43 ||
    coverage['personas_covered'] !== 43 ||
    coverage['journeys_required'] !== 419 ||
    coverage['journeys_covered'] !== 419
  ) {
    throw new Error('WP-029 corpus coverage drift');
  }
  for (const [index, subject] of raw['subjects'].entries()) {
    if (
      !isRecord(subject) ||
      typeof subject['subjectId'] !== 'string' ||
      typeof subject['personaSlug'] !== 'string' ||
      !Array.isArray(subject['journeys']) ||
      !subject['journeys'].every((journey) => typeof journey === 'string') ||
      subject['synthetic'] !== true
    ) {
      throw new Error('WP-029 corpus subject ' + index + ' is invalid or non-synthetic');
    }
  }
  return raw as unknown as SynthCorpus;
}

export function assertCorpusReference(corpus: SynthCorpus, reference: CorpusReference): void {
  const subject = corpus.subjects.find((candidate) => candidate.subjectId === reference.subjectId);
  if (!subject) {
    throw new Error('unknown corpus subject: ' + reference.subjectId);
  }
  if (subject.personaSlug !== reference.personaSlug) {
    throw new Error('corpus persona mismatch for ' + reference.subjectId);
  }
  if (!subject.journeys.includes(reference.journey)) {
    throw new Error(
      'corpus journey mismatch for ' + reference.subjectId + ': ' + reference.journey,
    );
  }
}

export function corpusCovers(corpus: SynthCorpus, personaSlug: string, journey: string): boolean {
  return corpus.subjects.some(
    (subject) =>
      subject.personaSlug === personaSlug &&
      (journey.length === 0 || subject.journeys.includes(journey)),
  );
}
