import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { auditPaiCoverage } from './audit.js';
import { EXPECTED_PAI_IDS, type CanonicalRequirement } from './load-canonical.js';

type FixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

interface FixturePack {
  readonly requirementId: 'WP-106/PAI-COVERAGE';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly requirements: readonly CanonicalRequirement[];
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/WP-106.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (
    raw.requirementId !== 'WP-106/PAI-COVERAGE' ||
    raw.fixtureClass !== fixtureClass ||
    raw.synthetic !== true ||
    !Array.isArray(raw.requirements)
  ) {
    throw new Error(`INVALID_WP106_FIXTURE:${fixtureClass}`);
  }
  return raw as FixturePack;
}

describe('WP-106 fixtures', () => {
  it('HAPPY maps all twenty PAI ids', () => {
    const audit = auditPaiCoverage(loadPack('HAPPY').requirements);
    expect(audit.allExpectedMapped).toBe(true);
    expect(audit.unmappedPaiIds).toEqual([]);
  });

  it('BOUNDARY records PAI without REQ-AI and flagged-without-pai', () => {
    const audit = auditPaiCoverage(loadPack('BOUNDARY').requirements);
    expect(audit.allExpectedMapped).toBe(true);
    expect(audit.paiWithoutReqAi).toContain('PAI-08');
    expect(audit.flaggedWithoutPai).toContain('REQ-AI-047');
  });

  it('FAILURE leaves one expected PAI unmapped', () => {
    const audit = auditPaiCoverage(loadPack('FAILURE').requirements);
    expect(audit.allExpectedMapped).toBe(false);
    expect(audit.unmappedPaiIds).toEqual(['PAI-20']);
  });

  it('RECOVERY restores a previously missing PAI mapping', () => {
    const missing = auditPaiCoverage(loadPack('FAILURE').requirements);
    expect(missing.unmappedPaiIds).toEqual(['PAI-20']);
    const recovered = auditPaiCoverage(loadPack('RECOVERY').requirements);
    expect(recovered.allExpectedMapped).toBe(true);
    expect(recovered.unmappedPaiIds).toEqual([]);
    expect(EXPECTED_PAI_IDS).toHaveLength(20);
  });
});
