import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { auditPaiCoverage, renderAuditMarkdown } from './audit.js';
import { canonicalJsonPath, EXPECTED_PAI_IDS, loadCanonicalDocument } from './load-canonical.js';

const directories: string[] = [];
function fixture(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'pai-canonical-'));
  directories.push(directory);
  const path = join(directory, 'canonical.json');
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

describe('portable canonical document loading', () => {
  it('resolves the default relative to this module in any checkout', () => {
    expect(canonicalJsonPath()).toBe(
      fileURLToPath(
        new URL('../../../docs/requirements/canonical-requirements.json', import.meta.url),
      ),
    );
  });

  it('loads and audits synthetic coverage without private documents', () => {
    const requirements = EXPECTED_PAI_IDS.map((pai, index) => ({
      id: `REQ-AI-SYNTHETIC-${String(index)}`,
      provider_ai_flag: true,
      pai_refs: [pai],
    }));
    const document = loadCanonicalDocument(fixture({ requirements }));
    expect(document.count).toBe(20);
    const audit = auditPaiCoverage(document.requirements);
    expect(audit.allExpectedMapped).toBe(true);
    expect(audit.unmappedPaiIds).toEqual([]);
    expect(audit.unexpectedPaiIds).toEqual([]);
    expect(renderAuditMarkdown(audit)).toContain('allExpectedMapped: true');
  });

  it('rejects empty or absent requirements', () => {
    for (const value of [{}, { requirements: [] }]) {
      expect(() => loadCanonicalDocument(fixture(value))).toThrow('CANONICAL_REQUIREMENTS_MISSING');
    }
  });

  it('fails when the explicitly requested document is missing', () => {
    expect(() => loadCanonicalDocument(fixture({}) + '.missing')).toThrow();
  });
});
