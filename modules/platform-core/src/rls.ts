/**
 * RLS generator (WP-010). Modules declare their tables; the generator emits
 * the row-level-security DDL that every module migration embeds between
 * `-- rls:generated:begin` and `-- rls:generated:end` markers. A drift test
 * compares the committed migration block against a fresh emission, and the
 * coverage guard makes the migration itself fail if any table in the schema
 * lacks forced RLS.
 *
 * Session convention (docs/contracts/tenancy-types.md): the auth layer binds
 * `SET LOCAL practicehub.tenant_id`; policies compare the tenant column to
 * `current_setting('practicehub.tenant_id', true)`, so an unbound session
 * reads zero rows and cannot write — fail-closed.
 */

const identifierPattern = /^[a-z_][a-z0-9_]*$/;

export const tenantBindingSetting = 'practicehub.tenant_id';

export interface RlsTableSpec {
  readonly schema: string;
  readonly table: string;
  readonly kind: 'tenant-scoped' | 'platform-global';
  /** Tenant column for tenant-scoped tables; defaults to `tenant_id`. */
  readonly tenantColumn?: string;
  /** Required for platform-global tables: why this table carries no tenant rows. */
  readonly justification?: string;
}

export class RlsGeneratorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RlsGeneratorError';
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) {
    throw new RlsGeneratorError(
      `${label} must match ${identifierPattern.source}; received ${JSON.stringify(value)}`,
    );
  }
}

function validateSpecs(specs: readonly RlsTableSpec[]): void {
  const seen = new Set<string>();
  for (const spec of specs) {
    assertIdentifier(spec.schema, 'schema');
    assertIdentifier(spec.table, 'table');
    assertIdentifier(spec.tenantColumn ?? 'tenant_id', 'tenantColumn');
    const qualified = `${spec.schema}.${spec.table}`;
    if (seen.has(qualified)) {
      throw new RlsGeneratorError(`duplicate table spec ${qualified}`);
    }
    seen.add(qualified);
    if (spec.kind === 'platform-global' && !spec.justification?.trim()) {
      throw new RlsGeneratorError(
        `platform-global table ${qualified} requires a written justification`,
      );
    }
  }
}

function sorted(specs: readonly RlsTableSpec[]): RlsTableSpec[] {
  return [...specs].sort((left, right) =>
    `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`),
  );
}

/**
 * Emit ENABLE + FORCE row level security and the tenant-isolation policy for
 * every tenant-scoped table. Platform-global tables still get forced RLS with
 * an explicit allow-all policy so the coverage guard stays uniform; their
 * justification is embedded as a comment.
 */
export function generateRlsDdl(specs: readonly RlsTableSpec[]): string {
  validateSpecs(specs);
  const statements: string[] = [];
  for (const spec of sorted(specs)) {
    const qualified = `${spec.schema}.${spec.table}`;
    const tenantColumn = spec.tenantColumn ?? 'tenant_id';
    statements.push(
      `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;`,
      `DROP POLICY IF EXISTS tenant_isolation ON ${qualified};`,
    );
    if (spec.kind === 'tenant-scoped') {
      statements.push(
        `CREATE POLICY tenant_isolation ON ${qualified}`,
        `  USING (${tenantColumn} = current_setting('${tenantBindingSetting}', true))`,
        `  WITH CHECK (${tenantColumn} = current_setting('${tenantBindingSetting}', true));`,
      );
    } else {
      statements.push(
        `-- platform-global: ${spec.justification ?? ''}`.trimEnd(),
        `CREATE POLICY tenant_isolation ON ${qualified}`,
        `  USING (true)`,
        `  WITH CHECK (true);`,
      );
    }
    statements.push('');
  }
  return statements.join('\n');
}

/**
 * Emit a DO block that raises if any table in the schema lacks enabled+forced
 * RLS or is not declared in the spec list — undeclared tables are refused by
 * construction, not by review memory.
 */
export function generateRlsCoverageGuard(schema: string, specs: readonly RlsTableSpec[]): string {
  assertIdentifier(schema, 'schema');
  validateSpecs(specs);
  const declared = sorted(specs.filter((spec) => spec.schema === schema)).map((spec) => spec.table);
  const declaredLiteral = declared.map((table) => `'${table}'`).join(', ');
  return [
    'DO $coverage$',
    'DECLARE',
    '  offender text;',
    'BEGIN',
    "  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)",
    '    INTO offender',
    '    FROM pg_class c',
    '    JOIN pg_namespace n ON n.oid = c.relnamespace',
    `   WHERE n.nspname = '${schema}'`,
    "     AND c.relkind = 'r'",
    '     AND (NOT c.relrowsecurity',
    '          OR NOT c.relforcerowsecurity',
    `          OR c.relname NOT IN (${declaredLiteral}));`,
    '  IF offender IS NOT NULL THEN',
    `    RAISE EXCEPTION 'rls coverage failure in schema ${schema}: %', offender;`,
    '  END IF;',
    'END',
    '$coverage$;',
  ].join('\n');
}

export const rlsGeneratedBeginMarker = '-- rls:generated:begin';
export const rlsGeneratedEndMarker = '-- rls:generated:end';

/**
 * Render the generated section a module migration embeds verbatim. `specs`
 * are the tables THIS migration creates (its DDL scope); `guardSpecs` default
 * to `specs` but a schema whose tables span migrations passes the full
 * registry so every migration's coverage guard declares the whole schema —
 * re-applying an early migration after a later one stays clean, while an
 * undeclared table still raises.
 */
export function renderRlsMigrationSection(
  schema: string,
  specs: readonly RlsTableSpec[],
  guardSpecs: readonly RlsTableSpec[] = specs,
): string {
  return [
    rlsGeneratedBeginMarker,
    '-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.',
    '-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.',
    generateRlsDdl(specs),
    generateRlsCoverageGuard(schema, guardSpecs),
    rlsGeneratedEndMarker,
  ].join('\n');
}

/** Extract the generated section from a migration file's contents. */
export function extractRlsMigrationSection(migrationSql: string): string | null {
  const begin = migrationSql.indexOf(rlsGeneratedBeginMarker);
  const end = migrationSql.indexOf(rlsGeneratedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return migrationSql.slice(begin, end + rlsGeneratedEndMarker.length);
}

const tenantIdValuePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Transaction-scoped tenant binding (`SET LOCAL`) so pooled connections never
 * leak a binding across transactions. Tenant ids are a controlled vocabulary;
 * anything else is rejected rather than escaped.
 */
export function tenantBindingSql(tenantId: string): string {
  if (!tenantIdValuePattern.test(tenantId)) {
    throw new RlsGeneratorError(
      `tenant id must match ${tenantIdValuePattern.source}; received ${JSON.stringify(tenantId)}`,
    );
  }
  return `SET LOCAL ${tenantBindingSetting} = '${tenantId}';`;
}

/** Tables created by 0001-tenancy.sql (WP-010) — that migration's DDL scope. */
export const tenancyRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'platform_core', table: 'synthetic_tenant', kind: 'tenant-scoped' },
  { schema: 'platform_core', table: 'tenant', kind: 'tenant-scoped' },
  { schema: 'platform_core', table: 'legal_entity', kind: 'tenant-scoped' },
  { schema: 'platform_core', table: 'location', kind: 'tenant-scoped' },
  { schema: 'platform_core', table: 'tenant_config', kind: 'tenant-scoped' },
];

/** Tables created by 0002-jurisdiction.sql (WP-011) — that migration's DDL scope. */
export const jurisdictionRlsSpecs: readonly RlsTableSpec[] = [
  {
    schema: 'platform_core',
    table: 'jurisdiction_rule_pack',
    kind: 'platform-global',
    justification:
      'Statutory jurisdiction rule content; law is tenant-independent reference data (ADR-005 Decision 5)',
  },
  {
    schema: 'platform_core',
    table: 'jurisdiction_rule',
    kind: 'platform-global',
    justification:
      'Statutory jurisdiction rule content; law is tenant-independent reference data (ADR-005 Decision 5)',
  },
  { schema: 'platform_core', table: 'location_capture', kind: 'tenant-scoped' },
];

/** Tables created by 0003-capability.sql (WP-012) — that migration's DDL scope. */
export const capabilityRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'platform_core', table: 'capability_event', kind: 'tenant-scoped' },
  { schema: 'platform_core', table: 'capability_grant', kind: 'tenant-scoped' },
];

/** The full platform_core table registry — every migration's coverage guard declares it. */
export const platformCoreRlsSpecs: readonly RlsTableSpec[] = [
  ...tenancyRlsSpecs,
  ...jurisdictionRlsSpecs,
  ...capabilityRlsSpecs,
];
