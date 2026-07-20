import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { RlsTableSpec } from './rls.js';
import {
  extractRlsMigrationSection,
  generateRlsCoverageGuard,
  generateRlsDdl,
  jurisdictionRlsSpecs,
  platformCoreRlsSpecs,
  renderRlsMigrationSection,
  RlsGeneratorError,
  tenancyRlsSpecs,
  tenantBindingSql,
} from './rls.js';

const tenancyMigrationPath = fileURLToPath(
  new URL('../migrations/0001-tenancy.sql', import.meta.url),
);
const jurisdictionMigrationPath = fileURLToPath(
  new URL('../migrations/0002-jurisdiction.sql', import.meta.url),
);

describe('rls generator', () => {
  it('emits deterministic DDL regardless of spec order', () => {
    const reversed = [...platformCoreRlsSpecs].reverse();
    expect(generateRlsDdl(reversed)).toBe(generateRlsDdl(platformCoreRlsSpecs));
    expect(generateRlsDdl(platformCoreRlsSpecs)).toContain(
      "current_setting('practicehub.tenant_id', true)",
    );
  });

  it('forces RLS and creates a tenant-isolation policy for every tenant-scoped table', () => {
    const ddl = generateRlsDdl(platformCoreRlsSpecs);
    for (const spec of platformCoreRlsSpecs) {
      const qualified = `${spec.schema}.${spec.table}`;
      expect(ddl).toContain(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`);
      expect(ddl).toContain(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;`);
      expect(ddl).toContain(`CREATE POLICY tenant_isolation ON ${qualified}`);
    }
  });

  it('T-07a: refuses undeclared platform-global tables and bad identifiers', () => {
    const unjustified: RlsTableSpec = {
      schema: 'platform_core',
      table: 'rogue',
      kind: 'platform-global',
    };
    expect(() => generateRlsDdl([unjustified])).toThrow(/requires a written justification/);
    expect(() =>
      generateRlsDdl([{ schema: 'platform_core', table: 'bad-name', kind: 'tenant-scoped' }]),
    ).toThrow(RlsGeneratorError);
    expect(() =>
      generateRlsDdl([...platformCoreRlsSpecs, platformCoreRlsSpecs[0] as RlsTableSpec]),
    ).toThrow(/duplicate table spec/);
  });

  it('coverage guard names the schema and every declared table', () => {
    const guard = generateRlsCoverageGuard('platform_core', platformCoreRlsSpecs);
    expect(guard).toContain("n.nspname = 'platform_core'");
    for (const spec of platformCoreRlsSpecs) {
      expect(guard).toContain(`'${spec.table}'`);
    }
    expect(guard).toContain('RAISE EXCEPTION');
  });

  it('T-DRIFT: 0001-tenancy.sql embeds exactly its generated section (schema-wide guard)', () => {
    const migration = readFileSync(tenancyMigrationPath, 'utf8');
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded?.replaceAll('\r\n', '\n')).toBe(
      renderRlsMigrationSection('platform_core', tenancyRlsSpecs, platformCoreRlsSpecs),
    );
  });

  it('T-DRIFT: 0002-jurisdiction.sql embeds exactly its generated section (schema-wide guard)', () => {
    const migration = readFileSync(jurisdictionMigrationPath, 'utf8');
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded?.replaceAll('\r\n', '\n')).toBe(
      renderRlsMigrationSection('platform_core', jurisdictionRlsSpecs, platformCoreRlsSpecs),
    );
  });

  it('every migration guard declares the full registry, so re-application stays clean', () => {
    for (const path of [tenancyMigrationPath, jurisdictionMigrationPath]) {
      const embedded = extractRlsMigrationSection(readFileSync(path, 'utf8')) ?? '';
      for (const spec of platformCoreRlsSpecs) {
        expect(embedded, `${path} guard must declare ${spec.table}`).toContain(`'${spec.table}'`);
      }
    }
  });

  it('T-13a: tenant binding is SET LOCAL and rejects non-vocabulary ids', () => {
    expect(tenantBindingSql('northwind-synthetic')).toBe(
      "SET LOCAL practicehub.tenant_id = 'northwind-synthetic';",
    );
    for (const bad of ["northwind'; DROP TABLE x; --", 'UPPER', '', 'has space']) {
      expect(() => tenantBindingSql(bad)).toThrow(RlsGeneratorError);
    }
  });
});
