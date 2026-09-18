import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EntitlementsEngine } from './engine.js';
import { CatalogDouble } from './testing/catalog-double.js';
import { MembershipDouble } from './testing/membership-double.js';
import type { ConsumeCommand } from './types.js';

function seed() {
  const catalog = new CatalogDouble();
  catalog.put({
    skuRef: 'cash-visit',
    billedComponentRefs: ['visit-core'],
    lines: [{ componentRef: 'visit-core', coverage: 'non-covered', amountCents: 15000 }],
  });
  catalog.put({
    skuRef: 'awv',
    billedComponentRefs: ['awv-core'],
    lines: [{ componentRef: 'awv-core', coverage: 'covered', amountCents: 20000 }],
  });
  catalog.put({
    skuRef: 'mixed',
    billedComponentRefs: ['awv-core', 'cash-add'],
    lines: [
      { componentRef: 'awv-core', coverage: 'covered', amountCents: 20000 },
      { componentRef: 'cash-add', coverage: 'non-covered', amountCents: 4000 },
    ],
  });
  catalog.put({
    skuRef: 'unknown',
    billedComponentRefs: ['x'],
    lines: [{ componentRef: 'x', coverage: 'unclassified', amountCents: 1000 }],
  });
  const membership = new MembershipDouble();
  membership.put({
    memberRef: 'member-1',
    vintageId: 'v-2026',
    payer: 'member',
    state: 'active',
  });
  membership.put({
    memberRef: 'employer-1',
    vintageId: 'v-emp',
    payer: 'employer',
    state: 'active',
  });
  membership.put({
    memberRef: 'paused-1',
    vintageId: 'v-pause',
    payer: 'member',
    state: 'paused',
  });
  return { catalog, membership, engine: new EntitlementsEngine(catalog, membership) };
}

function command(overrides: Partial<ConsumeCommand> = {}): ConsumeCommand {
  return {
    tenantId: 'tenant-1',
    idempotencyKey: 'idem-1',
    memberRef: 'member-1',
    vintageId: 'v-2026',
    skuRef: 'cash-visit',
    billedComponentRefs: ['visit-core'],
    discountCents: 1000,
    ...overrides,
  };
}

describe('WP-053 entitlements engine', () => {
  it('consumes a non-covered composition with a legal discount', async () => {
    const { engine } = seed();
    const result = await engine.consume(command());
    expect(result).toMatchObject({ ok: true, allowedDiscountCents: 1000 });
  });

  it('blocks discount on a covered-only billed set', async () => {
    const { engine } = seed();
    const result = await engine.consume(
      command({ skuRef: 'awv', billedComponentRefs: ['awv-core'], discountCents: 500 }),
    );
    expect(result).toEqual({ ok: false, code: 'DISCOUNT_ON_COVERED' });
  });

  it('allows discount only up to the non-covered remainder of a mixed set', async () => {
    const { engine } = seed();
    const ok = await engine.consume(
      command({
        skuRef: 'mixed',
        billedComponentRefs: ['awv-core', 'cash-add'],
        discountCents: 4000,
      }),
    );
    expect(ok).toMatchObject({ ok: true, allowedDiscountCents: 4000 });
    const { engine: other } = seed();
    const denied = await other.consume(
      command({
        skuRef: 'mixed',
        billedComponentRefs: ['awv-core', 'cash-add'],
        discountCents: 4001,
      }),
    );
    expect(denied).toEqual({ ok: false, code: 'DISCOUNT_ON_COVERED' });
  });

  it('serializes a double-consumption race to one winner', async () => {
    const { engine } = seed();
    const [a, b] = await Promise.all([
      engine.consume(command({ idempotencyKey: 'race-a' })),
      engine.consume(command({ idempotencyKey: 'race-b' })),
    ]);
    const codes = [a, b].map((row) => (row.ok ? 'ok' : row.code)).sort();
    expect(codes).toEqual(['DOUBLE_CONSUMPTION', 'ok']);
  });

  it('freezes consume on paused membership and refuses unclassified SKUs', async () => {
    const { engine } = seed();
    expect(await engine.consume(command({ memberRef: 'paused-1', vintageId: 'v-pause' }))).toEqual({
      ok: false,
      code: 'MEMBERSHIP_FROZEN',
    });
    expect(
      await engine.consume(
        command({
          skuRef: 'unknown',
          billedComponentRefs: ['x'],
          discountCents: 0,
          idempotencyKey: 'unclassified',
        }),
      ),
    ).toEqual({ ok: false, code: 'UNCLASSIFIED_CANNOT_SELL' });
  });

  it('keeps employer vintages distinct from member vintages', async () => {
    const { engine } = seed();
    const employer = await engine.consume(
      command({ memberRef: 'employer-1', vintageId: 'v-emp', idempotencyKey: 'emp' }),
    );
    expect(employer.ok).toBe(true);
    const wrongVintage = await engine.consume(
      command({ memberRef: 'employer-1', vintageId: 'v-2026', idempotencyKey: 'emp-wrong' }),
    );
    expect(wrongVintage).toEqual({ ok: false, code: 'VINTAGE_MISMATCH' });
  });

  it('loads the four-class fixture corpus', async () => {
    const directory = new URL('../fixtures/', import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    const fixtures = names.map(
      (name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as { class: string },
    );
    expect(new Set(fixtures.map((fixture) => fixture.class))).toEqual(
      new Set(['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY']),
    );
  });
});
