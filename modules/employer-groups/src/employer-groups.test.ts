import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { GipaSurface } from './gipa-surface.js';
import { invoiceFromRoster } from './invoice-shape.js';
import { MultiTinRegistry } from './multi-tin.js';
import { QleCobra } from './qle-cobra.js';
import { RosterStore } from './roster.js';
import type { EmployerGroup, RosterRow, TenantId, Tin } from './types.js';
import { EmployerGroupError } from './types.js';
import { Wp053EntitlementsDouble } from './wp053-entitlements-double.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const tenant = 'northwind-synthetic' as TenantId;
const tinA = '12-3456789' as Tin;
const tinB = '98-7654321' as Tin;
const employerRef = 'northwind-group';

function group(): EmployerGroup {
  return {
    contractId: 'employer-group/v1',
    tenantId: tenant,
    employerRef,
    tins: [tinA, tinB],
    committedHeadcount: 2,
    rates: { employee: 100, family: 250 },
    synthetic: true,
  };
}

function row(employeeId: string, extra: Partial<RosterRow> = {}): RosterRow {
  return {
    employeeId,
    name: extra.name ?? employeeId,
    dob: extra.dob ?? '1990-01-01',
    tin: extra.tin ?? tinA,
    tier: extra.tier ?? 'employee',
    status: extra.status ?? 'active',
    effectiveDate: extra.effectiveDate ?? '2026-09-18',
    terminationDate: extra.terminationDate ?? null,
    medicareEligible: extra.medicareEligible ?? false,
    source: extra.source ?? 'csv',
    synthetic: true,
  };
}

function harness() {
  const registry = new MultiTinRegistry();
  registry.register(group());
  const entitlements = new Wp053EntitlementsDouble();
  const roster = new RosterStore(registry, entitlements);
  return { registry, entitlements, roster, qle: new QleCobra(roster) };
}

describe('REQ-MEM-013 fixtures four-class', () => {
  it('loads unique case names', () => {
    const names = new Set<string>();
    for (const cls of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
      const raw = JSON.parse(
        readFileSync(join(fixtureRoot, `REQ-MEM-013.${cls}.json`), 'utf8'),
      ) as { requirementId: string; class: string; cases: readonly { name: string }[] };
      expect(raw.requirementId).toBe('REQ-MEM-013');
      expect(raw.class).toBe(cls);
      for (const item of raw.cases) {
        expect(names.has(item.name)).toBe(false);
        names.add(item.name);
      }
    }
    expect(names.size).toBe(8);
  });
});

describe('HAPPY', () => {
  it('validated roster diffs then applies only after confirm', () => {
    const { roster, entitlements } = harness();
    const preview = roster.preview(employerRef, [row('e1'), row('e2')]);
    expect(preview.confirmed).toBe(false);
    expect(roster.activeRows()).toHaveLength(0);
    expect(entitlements.consume()).toEqual({ supported: false, code: 'CONSUME_DEFERRED_WP053' });
    const applied = roster.confirm(employerRef, '2026-09-18T12:00:00.000Z');
    expect(applied.confirmed).toBe(true);
    expect(roster.activeRows()).toHaveLength(2);
    expect(entitlements.check(tenant, 'e1', 'sponsored-eligibility')).toBe(true);
  });

  it('invoice is headcount times tier times rate only', () => {
    const { registry, roster } = harness();
    roster.preview(employerRef, [row('e1'), row('e2', { tier: 'family' })]);
    roster.confirm(employerRef, '2026-09-18T12:00:00.000Z');
    const lines = invoiceFromRoster(registry, employerRef, roster.activeRows());
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: 'employee', headcount: 1, rate: 100, amount: 100 }),
        expect.objectContaining({ tier: 'family', headcount: 1, rate: 250, amount: 250 }),
      ]),
    );
  });
});

describe('BOUNDARY', () => {
  it('invalid rows hold while valid rows proceed', () => {
    const { roster } = harness();
    const preview = roster.preview(employerRef, [row('ok'), row('bad', { name: '' })]);
    expect(preview.heldCount).toBe(1);
    expect(preview.invitedCount).toBe(1);
    roster.confirm(employerRef, '2026-09-18T12:00:00.000Z');
    expect(roster.activeRows().map((item) => item.employeeId)).toEqual(['ok']);
  });

  it('headcount variance flags without silent accept', () => {
    const { roster } = harness();
    const preview = roster.preview(employerRef, [row('only')]);
    expect(preview.headcountVariance).toBe(true);
    expect(preview.confirmed).toBe(false);
  });
});

describe('FAILURE', () => {
  it('upload does not auto-apply', () => {
    const { roster } = harness();
    roster.preview(employerRef, [row('e1')]);
    expect(roster.activeRows()).toHaveLength(0);
  });

  it('clinical employer query is refused', () => {
    const surface = new GipaSurface(true);
    expect(() => surface.query({ employerRef, employeeId: 'e1', field: 'clinical' })).toThrow(
      EmployerGroupError,
    );
  });
});

describe('RECOVERY', () => {
  it('termination QLE ends eligibility going forward', () => {
    const { roster, qle, entitlements } = harness();
    roster.preview(employerRef, [row('e1')]);
    roster.confirm(employerRef, '2026-09-18T12:00:00.000Z');
    qle.ingest(employerRef, {
      employeeId: 'e1',
      kind: 'termination',
      at: '2026-10-01',
      synthetic: true,
    });
    expect(roster.activeRows()).toHaveLength(0);
    expect(entitlements.check(tenant, 'e1', 'sponsored-eligibility')).toBe(false);
  });

  it('medicare-eligible add is MSP queued before grant', () => {
    const { roster, entitlements } = harness();
    roster.preview(employerRef, [row('m1', { medicareEligible: true })]);
    roster.confirm(employerRef, '2026-09-18T12:00:00.000Z');
    expect(roster.mspQueue).toEqual(['m1']);
    expect(entitlements.check(tenant, 'm1', 'sponsored-eligibility')).toBe(false);
  });
});

describe('GIPA fail-closed and multi-TIN', () => {
  it('denies employer surface when partition is not simulated', () => {
    const surface = new GipaSurface(false);
    expect(() => surface.query({ employerRef, employeeId: 'e1', field: 'eligibility' })).toThrow(
      /gipa-partition/,
    );
  });

  it('rejects a TIN not on the employer', () => {
    const { roster } = harness();
    const preview = roster.preview(employerRef, [row('x', { tin: '00-0000000' as Tin })]);
    expect(preview.errors[0]?.reason).toBe('tin-not-on-employer');
  });
});
