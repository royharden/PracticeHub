import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import {
  buildPersonaStoryMatrix,
  computeManifestCheckpoint,
  hashArtifactBytes,
  loadCorpusManifest,
  parsePersonaRegistry,
  parsePersonaStoryMatrix,
  serializePersonaStoryMatrix,
  verifyManifestArtifacts,
} from '@practicehub/testkit';
import type { ArtifactNormalization, SynthCorpusManifest } from '@practicehub/testkit';

import { failIfAny, repoRoot } from './common.js';

/**
 * Corpus gate (WP-005): verifies the SynthCorpus manifest (recovery_epoch +
 * manifest_checkpoint contract), the fenced artifact hashes and synthetic
 * watermarks, and the persona×story matrix (regeneration equality + the
 * four-class fixture floor). `--write` regenerates the matrix and re-fences
 * the manifest; verification never mutates anything.
 */

const manifestPath = resolve(repoRoot, 'packages/testkit/fixtures/corpus-manifest.synthetic.json');
const matrixPath = resolve(repoRoot, 'docs/requirements/persona-story-matrix.csv');
const canonicalCsvPath = resolve(repoRoot, 'docs/requirements/canonical-requirements.csv');
const personasPath = resolve(repoRoot, 'docs/requirements/personas.json');
const testkitFixturesDir = resolve(repoRoot, 'packages/testkit/fixtures');

const requiredFencedPaths = [
  'packages/testkit/fixtures/tenants.synthetic.json',
  'docs/requirements/persona-story-matrix.csv',
  'docs/requirements/canonical-requirements.csv',
  'docs/requirements/canonical-requirements.json',
  'docs/requirements/personas.json',
  'docs/requirements/coverage-matrix.csv',
  'docs/requirements/source-crosswalk.csv',
];

function toRepoPath(absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join('/');
}

function regenerateMatrixText(): string {
  const registry = parsePersonaRegistry(readFileSync(personasPath, 'utf8'));
  const rows = buildPersonaStoryMatrix(readFileSync(canonicalCsvPath, 'utf8'), registry);
  return serializePersonaStoryMatrix(rows);
}

function writeMode(): void {
  writeFileSync(matrixPath, regenerateMatrixText(), 'utf8');
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const artifacts = raw.artifacts;
  if (!Array.isArray(artifacts)) {
    throw new Error('manifest.artifacts must be an array before re-fencing');
  }
  for (const artifact of artifacts as Record<string, unknown>[]) {
    const path = artifact.path;
    const normalization = artifact.normalization;
    if (typeof path !== 'string' || typeof normalization !== 'string') {
      throw new Error('every manifest artifact needs path and normalization before re-fencing');
    }
    artifact.sha256 = hashArtifactBytes(
      readFileSync(resolve(repoRoot, path)),
      normalization as ArtifactNormalization,
    );
  }
  raw.manifest_checkpoint = computeManifestCheckpoint(raw);
  writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  console.log(`corpus --write: re-fenced ${artifacts.length} artifacts and regenerated the matrix`);
}

function verifyMode(): void {
  const errors: string[] = [];

  let manifest: SynthCorpusManifest | null = null;
  try {
    manifest = loadCorpusManifest(manifestPath);
    console.log(
      `corpus_manifest=OK version=${manifest.corpus_version} recovery_epoch=${manifest.recovery_epoch}`,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (manifest) {
    errors.push(...verifyManifestArtifacts(manifest, repoRoot));

    const fenced = new Set(manifest.artifacts.map((artifact) => artifact.path));
    for (const required of requiredFencedPaths) {
      if (!fenced.has(required)) {
        errors.push(`${required} must be fenced by the corpus manifest`);
      }
    }
    const manifestRepoPath = toRepoPath(manifestPath);
    for (const entry of readdirSync(testkitFixturesDir)) {
      const repoPath = toRepoPath(resolve(testkitFixturesDir, entry));
      if (repoPath !== manifestRepoPath && !fenced.has(repoPath)) {
        errors.push(`${repoPath} is a committed fixture but is not fenced by the corpus manifest`);
      }
    }
    console.log(`corpus_artifacts=checked count=${manifest.artifacts.length}`);
  }

  try {
    const text = readFileSync(matrixPath, 'utf8');
    const rows = parsePersonaStoryMatrix(text);
    const regenerated = regenerateMatrixText();
    if (text.replaceAll('\r\n', '\n') !== regenerated) {
      errors.push(
        'docs/requirements/persona-story-matrix.csv does not match deterministic regeneration ' +
          'from the graduated corpus (seeded floor/coverage drift); regenerate via corpus --write',
      );
    }
    const requirementIds = new Set(rows.map((row) => row.canonicalId));
    const personaSlugs = new Set(rows.map((row) => row.personaSlug));
    console.log(
      `persona_story_matrix=OK rows=${rows.length} requirements=${requirementIds.size} personas=${personaSlugs.size}`,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  failIfAny('corpus', errors);
}

if (process.argv.includes('--write')) {
  writeMode();
} else {
  verifyMode();
}
