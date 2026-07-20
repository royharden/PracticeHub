import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  computeManifestCheckpoint,
  hashArtifactBytes,
  parseCorpusManifest,
  stableStringify,
  verifyManifestArtifacts,
} from './manifest.js';
import type { SynthCorpusManifest } from './manifest.js';

function baseManifest(): Record<string, unknown> {
  return {
    synthetic: true,
    corpus_version: 'SynthCorpus-v0',
    recovery_epoch: 'RE-000',
    simulated_clock_epoch: '2026-01-01T00:00:00Z',
    generator: { name: 'corpus-tooling-port', version: 'wp-005' },
    master_seed: 'practicehub-synthcorpus-v0',
    sources: [
      {
        name: 'bootstrap-seed-fixtures',
        version: 'plan-000',
        license: 'internal-synthetic',
        provenance: 'packages/testkit/fixtures/',
      },
    ],
    artifacts: [
      {
        path: 'packages/testkit/fixtures/tenants.synthetic.json',
        sha256: 'a'.repeat(64),
        normalization: 'lf',
        watermark: 'synthetic-true',
      },
    ],
  };
}

function withCheckpoint(manifest: Record<string, unknown>): Record<string, unknown> {
  return { ...manifest, manifest_checkpoint: computeManifestCheckpoint(manifest) };
}

describe('stableStringify', () => {
  it('is independent of key insertion order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, null] } })).toBe(
      stableStringify({ a: { c: [3, null], d: 2 }, b: 1 }),
    );
  });
});

describe('computeManifestCheckpoint', () => {
  it('ignores the checkpoint field itself and fences everything else', () => {
    const manifest = baseManifest();
    const checkpoint = computeManifestCheckpoint(manifest);
    expect(computeManifestCheckpoint({ ...manifest, manifest_checkpoint: 'x' })).toBe(checkpoint);
    expect(computeManifestCheckpoint({ ...manifest, recovery_epoch: 'RE-001' })).not.toBe(
      checkpoint,
    );
  });
});

describe('parseCorpusManifest', () => {
  it('accepts a schema-valid manifest with a matching checkpoint', () => {
    const manifest = withCheckpoint(baseManifest());
    expect(parseCorpusManifest(JSON.stringify(manifest)).corpus_version).toBe('SynthCorpus-v0');
  });

  it('rejects a checkpoint mismatch after a fenced field changes', () => {
    const manifest = withCheckpoint(baseManifest());
    const tampered = { ...manifest, recovery_epoch: 'RE-001' };
    expect(() => parseCorpusManifest(JSON.stringify(tampered))).toThrow(
      /manifest_checkpoint mismatch/,
    );
  });

  it('rejects a manifest without the synthetic watermark', () => {
    const manifest = baseManifest();
    manifest.synthetic = false;
    expect(() => parseCorpusManifest(JSON.stringify(withCheckpoint(manifest)))).toThrow(
      /synthetic watermark/,
    );
  });

  it('collects schema violations with precise paths', () => {
    const manifest = baseManifest();
    manifest.recovery_epoch = 'epoch-one';
    manifest.artifacts = [{ path: '../outside.json', sha256: 'zz', normalization: 'crlf' }];
    expect(() => parseCorpusManifest(JSON.stringify(withCheckpoint(manifest)))).toThrow(
      /recovery_epoch[\s\S]*repo-relative[\s\S]*sha256[\s\S]*normalization/,
    );
  });
});

describe('hashArtifactBytes', () => {
  it('folds CRLF to LF under lf normalization', () => {
    expect(hashArtifactBytes(Buffer.from('a,b\r\n1,2\r\n'), 'lf')).toBe(
      hashArtifactBytes(Buffer.from('a,b\n1,2\n'), 'lf'),
    );
    expect(hashArtifactBytes(Buffer.from('a,b\r\n1,2\r\n'), 'none')).not.toBe(
      hashArtifactBytes(Buffer.from('a,b\n1,2\n'), 'none'),
    );
  });
});

describe('verifyManifestArtifacts', () => {
  it('reports hash mismatches and missing watermarks; passes intact artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'practicehub-manifest-'));
    const good = { synthetic: true, tenants: [] };
    writeFileSync(join(root, 'good.synthetic.json'), JSON.stringify(good));
    writeFileSync(join(root, 'unwatermarked.json'), JSON.stringify({ tenants: [] }));
    const manifest = withCheckpoint({
      ...baseManifest(),
      artifacts: [
        {
          path: 'good.synthetic.json',
          sha256: hashArtifactBytes(Buffer.from(JSON.stringify(good)), 'lf'),
          normalization: 'lf',
          watermark: 'synthetic-true',
        },
        {
          path: 'unwatermarked.json',
          sha256: hashArtifactBytes(Buffer.from(JSON.stringify({ tenants: [] })), 'lf'),
          normalization: 'lf',
          watermark: 'synthetic-true',
        },
        {
          path: 'absent.json',
          sha256: 'b'.repeat(64),
          normalization: 'lf',
          watermark: 'corpus-doc',
        },
      ],
    });
    const parsed: SynthCorpusManifest = parseCorpusManifest(JSON.stringify(manifest));
    const errors = verifyManifestArtifacts(parsed, root);
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toMatch(/unwatermarked\.json lacks the synthetic watermark/);
    expect(errors.join('\n')).toMatch(/absent\.json is fenced by the manifest but missing/);

    writeFileSync(join(root, 'good.synthetic.json'), JSON.stringify({ ...good, extra: 1 }));
    const afterTamper = verifyManifestArtifacts(parsed, root);
    expect(afterTamper.join('\n')).toMatch(/good\.synthetic\.json hash mismatch/);
  });
});
