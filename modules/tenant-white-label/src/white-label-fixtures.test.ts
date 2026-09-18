import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { assembleTenant2Profile } from './assemble.js';
import { TenantWhiteLabelStore } from './store.js';
import { wp077BrandDoubleV1 } from './testing/wp077-brand-double-v1.js';
import { wp118BootstrapDoubleV1 } from './testing/wp118-bootstrap-double-v1.js';

const directory = fileURLToPath(new URL('../fixtures', import.meta.url));

interface WhiteLabelFixtureCase {
  readonly name: string;
  readonly op: string;
  readonly expectWordmark?: string;
  readonly expectError?: string;
}

const fixtureOps = [
  'own-tenant-read',
  'missing-profile',
  'cross-tenant-read',
  'recover-own-read',
] as const;

function seededStore() {
  const store = new TenantWhiteLabelStore();
  const profile = assembleTenant2Profile({
    tenantId: 'tenant-2',
    brand: wp077BrandDoubleV1(),
    bootstrap: wp118BootstrapDoubleV1(),
    faxCoverRef: 'tpl:fax-2',
    letterheadRef: 'tpl:letter-2',
    printers: ['prn:t2'],
    faxNumberRef: 'fax:t2',
    synthetic: true,
  });
  store.put(profile, 'tenant-2');
  return store;
}

function runCase(fixtureCase: WhiteLabelFixtureCase): void {
  const store = seededStore();
  switch (fixtureCase.op) {
    case 'own-tenant-read':
    case 'recover-own-read': {
      if (fixtureCase.op === 'recover-own-read') {
        expect(() => store.get('tenant-2', 'tenant-1')).toThrow(
          'cross-tenant white-label read is forbidden',
        );
      }
      const profile = store.get('tenant-2', 'tenant-2');
      expect(profile.brand.wordmark).toBe(fixtureCase.expectWordmark);
      return;
    }
    case 'missing-profile': {
      const empty = new TenantWhiteLabelStore();
      expect(() => empty.get('tenant-2', 'tenant-2')).toThrow(fixtureCase.expectError);
      return;
    }
    case 'cross-tenant-read': {
      expect(() => store.get('tenant-2', 'tenant-1')).toThrow(fixtureCase.expectError);
      return;
    }
    default:
      throw new Error(`unknown op ${fixtureCase.op}`);
  }
}

describe('REQ-WL-001 fixture pack', () => {
  const pack = loadRequirementFixturePack(directory, 'REQ-WL-001');
  it('carries the complete four-class floor and a closed operation vocabulary', () => {
    expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    for (const fixtureClass of requiredFixtureClasses) {
      const fixture = pack.fixtures[fixtureClass] as { cases: readonly WhiteLabelFixtureCase[] };
      expect(fixture.cases.length).toBeGreaterThan(0);
      for (const fixtureCase of fixture.cases) {
        expect(fixtureOps).toContain(fixtureCase.op);
      }
    }
  });
  for (const fixtureClass of requiredFixtureClasses) {
    const fixture = pack.fixtures[fixtureClass] as { cases: readonly WhiteLabelFixtureCase[] };
    for (const fixtureCase of fixture.cases) {
      it(`${fixtureClass}: ${fixtureCase.name}`, () => {
        runCase(fixtureCase);
      });
    }
  }
});
