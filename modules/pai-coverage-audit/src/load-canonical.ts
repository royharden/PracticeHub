import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_PAI_IDS: readonly string[] = [
  'PAI-01',
  'PAI-02',
  'PAI-03',
  'PAI-04',
  'PAI-05',
  'PAI-06',
  'PAI-07',
  'PAI-08',
  'PAI-09',
  'PAI-10',
  'PAI-11',
  'PAI-12',
  'PAI-13',
  'PAI-14',
  'PAI-15',
  'PAI-16',
  'PAI-17',
  'PAI-18',
  'PAI-19',
  'PAI-20',
];

export interface CanonicalRequirement {
  readonly id: string;
  readonly provider_ai_flag?: boolean;
  readonly pai_refs?: readonly string[];
}

export interface CanonicalDocument {
  readonly count: number;
  readonly requirements: readonly CanonicalRequirement[];
}

export function canonicalJsonPath(): string {
  const relative = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../docs/requirements/canonical-requirements.json',
  );
  if (existsSync(relative)) {
    return relative;
  }
  return resolve(
    'C:/Users/Roy Harden/OneDrive/PJ-OD/PracticeHub/PracticeHub/docs/requirements/canonical-requirements.json',
  );
}

export function loadCanonicalDocument(path: string = canonicalJsonPath()): CanonicalDocument {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CanonicalDocument>;
  if (!Array.isArray(raw.requirements) || raw.requirements.length === 0) {
    throw new Error('CANONICAL_REQUIREMENTS_MISSING');
  }
  return { count: raw.count ?? raw.requirements.length, requirements: raw.requirements };
}
