import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertSyntheticFixture,
  fixtureClassFromPath,
  loadRequirementFixturePack,
  loadSyntheticJsonFixture,
  requiredFixtureClasses,
  requirementFixtureFileName,
} from './fixtures.js';

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'practicehub-testkit-'));
}

describe('assertSyntheticFixture', () => {
  it('accepts a watermarked fixture', () => {
    expect(() => assertSyntheticFixture({ synthetic: true, rows: [] })).not.toThrow();
  });

  it('rejects a fixture without the watermark', () => {
    expect(() => assertSyntheticFixture({ rows: [] })).toThrow(/synthetic watermark/);
    expect(() => assertSyntheticFixture({ synthetic: 'true' })).toThrow(/synthetic watermark/);
    expect(() => assertSyntheticFixture(null)).toThrow(/synthetic watermark/);
  });
});

describe('loadSyntheticJsonFixture', () => {
  it('refuses a fixture whose watermark was removed', () => {
    const dir = fixtureDir();
    const file = join(dir, 'sample.HAPPY.json');
    writeFileSync(file, JSON.stringify({ tenant: 'northwind-synthetic' }));
    expect(() => loadSyntheticJsonFixture(file)).toThrow(/missing the synthetic watermark/);
  });
});

describe('fixtureClassFromPath', () => {
  it('extracts the fixture class from the naming convention', () => {
    expect(fixtureClassFromPath('REQ-ID-001.RECOVERY.json')).toBe('RECOVERY');
    expect(fixtureClassFromPath('deep/dir/REQ-COMM-010.HAPPY.json')).toBe('HAPPY');
    expect(fixtureClassFromPath('REQ-ID-001.recovery.json')).toBeNull();
    expect(fixtureClassFromPath('REQ-ID-001.json')).toBeNull();
  });
});

describe('loadRequirementFixturePack', () => {
  it('loads all four classes when the floor is met', () => {
    const dir = fixtureDir();
    for (const fixtureClass of requiredFixtureClasses) {
      writeFileSync(
        join(dir, requirementFixtureFileName('REQ-ID-001', fixtureClass)),
        JSON.stringify({ synthetic: true, class: fixtureClass }),
      );
    }
    const pack = loadRequirementFixturePack(dir, 'REQ-ID-001');
    expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
  });

  it('fails closed naming the missing classes when below the floor', () => {
    const dir = fixtureDir();
    for (const fixtureClass of ['HAPPY', 'BOUNDARY'] as const) {
      writeFileSync(
        join(dir, requirementFixtureFileName('REQ-ID-002', fixtureClass)),
        JSON.stringify({ synthetic: true }),
      );
    }
    expect(() => loadRequirementFixturePack(dir, 'REQ-ID-002')).toThrow(
      /missing FAILURE, RECOVERY/,
    );
  });

  it('fails closed when a class file exists but lacks the watermark', () => {
    const dir = fixtureDir();
    for (const fixtureClass of requiredFixtureClasses) {
      writeFileSync(
        join(dir, requirementFixtureFileName('REQ-ID-003', fixtureClass)),
        JSON.stringify(fixtureClass === 'FAILURE' ? {} : { synthetic: true }),
      );
    }
    expect(() => loadRequirementFixturePack(dir, 'REQ-ID-003')).toThrow(
      /missing the synthetic watermark/,
    );
  });
});
