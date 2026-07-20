import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertSyntheticFixture } from './fixtures.js';

/**
 * SynthCorpus manifest contract (see docs/contracts/synthetic-corpus-manifest.md).
 * The manifest fences every committed corpus artifact behind a SHA-256 hash and
 * fences itself behind `manifest_checkpoint`; restores and reseeds are valid only
 * inside a recovery epoch whose checkpoint verifies.
 */

export const artifactNormalizations = ['lf', 'none'] as const;
export type ArtifactNormalization = (typeof artifactNormalizations)[number];

export const artifactWatermarks = ['synthetic-true', 'corpus-doc'] as const;
export type ArtifactWatermark = (typeof artifactWatermarks)[number];

export interface CorpusArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly normalization: ArtifactNormalization;
  readonly watermark: ArtifactWatermark;
}

export interface CorpusSource {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly provenance: string;
}

export interface SynthCorpusManifest {
  readonly synthetic: true;
  readonly corpus_version: string;
  readonly recovery_epoch: string;
  readonly simulated_clock_epoch: string;
  readonly generator: { readonly name: string; readonly version: string };
  readonly master_seed: string;
  readonly sources: readonly CorpusSource[];
  readonly artifacts: readonly CorpusArtifact[];
  readonly manifest_checkpoint: string;
}

const corpusVersionPattern = /^SynthCorpus-v\d+$/;
const recoveryEpochPattern = /^RE-\d{3,}$/;
const simulatedClockPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

/** Deterministic JSON: keys sorted at every level, no insignificant whitespace. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`stableStringify: unsupported value of type ${typeof value}`);
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hash artifact bytes under the declared normalization ('lf' folds CRLF to LF). */
export function hashArtifactBytes(bytes: Buffer, normalization: ArtifactNormalization): string {
  if (normalization === 'lf') {
    return sha256Hex(bytes.toString('utf8').replaceAll('\r\n', '\n'));
  }
  return sha256Hex(bytes);
}

/** The checkpoint covers the whole manifest except the checkpoint field itself. */
export function computeManifestCheckpoint(manifest: Record<string, unknown>): string {
  const fenced = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'manifest_checkpoint'),
  );
  return sha256Hex(stableStringify(fenced));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  where: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${where}.${key} must be a non-empty string`);
    return '';
  }
  return value;
}

/**
 * Parse and validate a SynthCorpus manifest document. Collects every schema
 * violation, then verifies `manifest_checkpoint`; any failure throws with the
 * full error list — manifest consumers fail closed.
 */
export function parseCorpusManifest(text: string): SynthCorpusManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`corpus manifest is not valid JSON: ${String(error)}`, { cause: error });
  }
  if (!isRecord(raw)) {
    throw new Error('corpus manifest must be a JSON object');
  }
  const errors: string[] = [];
  if (raw.synthetic !== true) {
    errors.push('manifest.synthetic must be exactly true (synthetic watermark)');
  }
  const corpusVersion = requireString(raw, 'corpus_version', errors, 'manifest');
  if (corpusVersion && !corpusVersionPattern.test(corpusVersion)) {
    errors.push(
      `manifest.corpus_version "${corpusVersion}" must match ${String(corpusVersionPattern)}`,
    );
  }
  const recoveryEpoch = requireString(raw, 'recovery_epoch', errors, 'manifest');
  if (recoveryEpoch && !recoveryEpochPattern.test(recoveryEpoch)) {
    errors.push(
      `manifest.recovery_epoch "${recoveryEpoch}" must match ${String(recoveryEpochPattern)}`,
    );
  }
  const simulatedClock = requireString(raw, 'simulated_clock_epoch', errors, 'manifest');
  if (simulatedClock && !simulatedClockPattern.test(simulatedClock)) {
    errors.push(
      `manifest.simulated_clock_epoch "${simulatedClock}" must be an ISO-8601 UTC instant`,
    );
  }
  if (isRecord(raw.generator)) {
    requireString(raw.generator, 'name', errors, 'manifest.generator');
    requireString(raw.generator, 'version', errors, 'manifest.generator');
  } else {
    errors.push('manifest.generator must be an object with name and version');
  }
  requireString(raw, 'master_seed', errors, 'manifest');
  if (Array.isArray(raw.sources) && raw.sources.length > 0) {
    raw.sources.forEach((source, index) => {
      if (!isRecord(source)) {
        errors.push(`manifest.sources[${index}] must be an object`);
        return;
      }
      for (const key of ['name', 'version', 'license', 'provenance']) {
        requireString(source, key, errors, `manifest.sources[${index}]`);
      }
    });
  } else {
    errors.push('manifest.sources must be a non-empty array');
  }
  const seenPaths = new Set<string>();
  if (Array.isArray(raw.artifacts) && raw.artifacts.length > 0) {
    raw.artifacts.forEach((artifact, index) => {
      if (!isRecord(artifact)) {
        errors.push(`manifest.artifacts[${index}] must be an object`);
        return;
      }
      const where = `manifest.artifacts[${index}]`;
      const path = requireString(artifact, 'path', errors, where);
      if (path) {
        if (path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) {
          errors.push(`${where}.path "${path}" must be repo-relative with forward slashes`);
        }
        if (seenPaths.has(path)) {
          errors.push(`${where}.path "${path}" is listed more than once`);
        }
        seenPaths.add(path);
      }
      const sha = requireString(artifact, 'sha256', errors, where);
      if (sha && !sha256Pattern.test(sha)) {
        errors.push(`${where}.sha256 must be 64 lowercase hex characters`);
      }
      if (!artifactNormalizations.includes(artifact.normalization as ArtifactNormalization)) {
        errors.push(`${where}.normalization must be one of ${artifactNormalizations.join(', ')}`);
      }
      if (!artifactWatermarks.includes(artifact.watermark as ArtifactWatermark)) {
        errors.push(`${where}.watermark must be one of ${artifactWatermarks.join(', ')}`);
      }
    });
  } else {
    errors.push('manifest.artifacts must be a non-empty array');
  }
  const checkpoint = requireString(raw, 'manifest_checkpoint', errors, 'manifest');
  if (errors.length === 0) {
    const expected = computeManifestCheckpoint(raw);
    if (checkpoint !== expected) {
      errors.push(
        `manifest_checkpoint mismatch: recorded ${checkpoint}, computed ${expected} — ` +
          'the manifest or its fenced fields changed without a checkpoint update',
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`corpus manifest invalid:\n- ${errors.join('\n- ')}`);
  }
  return raw as unknown as SynthCorpusManifest;
}

export function loadCorpusManifest(filePath: string): SynthCorpusManifest {
  return parseCorpusManifest(readFileSync(filePath, 'utf8'));
}

/**
 * Verify every fenced artifact against the manifest: the file exists, its
 * hash matches under the declared normalization, and `synthetic-true` class
 * artifacts carry the synthetic watermark. Returns one message per violation.
 */
export function verifyManifestArtifacts(manifest: SynthCorpusManifest, repoRoot: string): string[] {
  const errors: string[] = [];
  for (const artifact of manifest.artifacts) {
    const absolute = resolve(repoRoot, artifact.path);
    if (!existsSync(absolute)) {
      errors.push(`${artifact.path} is fenced by the manifest but missing`);
      continue;
    }
    const bytes = readFileSync(absolute);
    const actual = hashArtifactBytes(bytes, artifact.normalization);
    if (actual !== artifact.sha256) {
      errors.push(
        `${artifact.path} hash mismatch: manifest ${artifact.sha256}, actual ${actual} — ` +
          'artifact changed outside a manifest checkpoint update',
      );
    }
    if (artifact.watermark === 'synthetic-true') {
      try {
        assertSyntheticFixture(JSON.parse(bytes.toString('utf8')));
      } catch {
        errors.push(`${artifact.path} lacks the synthetic watermark (top-level synthetic=true)`);
      }
    }
  }
  return errors;
}
