import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventsWorkItemPort } from './workitem-port.js';
import { PgPaidServiceAttemptStore } from './attempt-store.js';
import { PgPaidServiceOrderStore } from './order-store.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const config = {
  host: process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1',
  port: Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432'),
  database: 'practicehub',
};
let owner: Client;
let app: Client;
beforeAll(async () => {
  owner = new Client({ ...config, user: 'practicehub', password: 'practicehub_synthetic_local' });
  app = new Client({
    ...config,
    user: 'practicehub_app',
    password: 'practicehub_app_synthetic_local',
  });
  await owner.connect();
  for (const file of [
    'infra/postgres/init/001-bootstrap.sql',
    'modules/platform-core/migrations/0001-tenancy.sql',
    'modules/events/migrations/0010-events.sql',
    'modules/events/migrations/0012-workitems.sql',
    'modules/payments-ledger/migrations/0019-cash-ledger.sql',
    'modules/membership-entitlements/migrations/0020-entitlement-ledger.sql',
    'modules/catalog-cash/migrations/0021-paid-service.sql',
    'infra/postgres/seed/022-paid-service-loop-seed.sql',
  ])
    await owner.query(readFileSync(`${root}${file}`, 'utf8'));
  await app.connect();
});
afterAll(async () => {
  await app?.end();
  await owner?.end();
});

async function transaction<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await operation();
    await app.query('ROLLBACK');
    return result;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

describe('catalog-cash DB and WP-022 parity', () => {
  it('reads only the bound synthetic tenant and rejects an overflowing amount', async () => {
    const northwind = await transaction('northwind-synthetic', async () =>
      app.query(`SELECT offer_version_ref FROM catalog_cash.catalog_offer`),
    );
    expect(northwind.rows.map((row) => row['offer_version_ref'])).toContain(
      'offer-paid-service-v1',
    );
    const riverbend = await transaction('riverbend-synthetic', async () =>
      app.query(
        `SELECT offer_version_ref FROM catalog_cash.catalog_offer WHERE tenant_id='northwind-synthetic'`,
      ),
    );
    expect(riverbend.rows).toHaveLength(0);
    await expect(
      transaction('northwind-synthetic', async () =>
        app.query(`INSERT INTO catalog_cash.catalog_offer
      (tenant_id,offer_version_ref,catalog_version_ref,opaque_processor_sku_ref,amount_minor,currency,expires_at,component_lines,cancellation_policy_ref,refund_policy_ref,synthetic)
      VALUES ('northwind-synthetic','overflow','v','sku',9007199254740992,'USD',now()+'1 day'::interval,'[{}]'::jsonb,'c','r',true)`),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('opens and assigns a real WP-022 WorkItem in the caller transaction', async () => {
    const result = await transaction('northwind-synthetic', async () => {
      const opened = await new EventsWorkItemPort(app).open({
        tenantId: 'northwind-synthetic',
        workItemId: 'wi-paid-db-1',
        subjectRef: 'paid-service-order:db-1',
        ownerRef: 'synthetic-staff:finance-1',
        reason: 'PAYMENT_UNKNOWN',
        responseDueAt: '2026-04-01T13:00:00Z',
        occurredAt: '2026-04-01T12:00:00Z',
        correlationId: 'corr:db:1',
      });
      const projection = await app.query(
        `SELECT purpose, owner_ref FROM events.work_item WHERE work_item_id='wi-paid-db-1'`,
      );
      return { opened, projection: projection.rows[0] };
    });
    expect(result).toEqual({
      opened: { workItemId: 'wi-paid-db-1' },
      projection: {
        purpose: 'paid-service-reconciliation:payment-unknown',
        owner_ref: 'synthetic-staff:finance-1',
      },
    });
  });

  it('durably retains an observed effect and enforces one refund authority per order', async () => {
    const suffix = randomUUID();
    const store = new PgPaidServiceAttemptStore(app);
    await store.reserve({
      tenantId: 'northwind-synthetic',
      operation: 'refund',
      idempotencyKey: `refund-db-a-${suffix}`,
      requestHash: 'a'.repeat(64),
      authorityHash: 'c'.repeat(64),
      orderRef: `order-db-${suffix}`,
    });
    await store.markSubmitted({
      tenantId: 'northwind-synthetic',
      operation: 'refund',
      idempotencyKey: `refund-db-a-${suffix}`,
    });
    expect(
      (await store.load('northwind-synthetic', 'refund', `refund-db-a-${suffix}`))?.submitted,
    ).toBe(true);
    await expect(
      store.markSubmitted({
        tenantId: 'northwind-synthetic',
        operation: 'refund',
        idempotencyKey: `refund-db-a-${suffix}`,
      }),
    ).rejects.toThrow('ATTEMPT_NOT_RESERVABLE');
    await store.recordEffect({
      tenantId: 'northwind-synthetic',
      operation: 'refund',
      idempotencyKey: `refund-db-a-${suffix}`,
      effect: {
        effectRef: `refund-effect-db-${suffix}`,
        outcome: 'unknown',
        observedAt: '2026-04-01T12:00:00Z',
      },
    });
    expect(
      (await store.load('northwind-synthetic', 'refund', `refund-db-a-${suffix}`))?.effect?.outcome,
    ).toBe('unknown');
    await expect(
      store.reserve({
        tenantId: 'northwind-synthetic',
        operation: 'refund',
        idempotencyKey: `refund-db-b-${suffix}`,
        requestHash: 'b'.repeat(64),
        authorityHash: 'c'.repeat(64),
        orderRef: `order-db-${suffix}`,
      }),
    ).rejects.toThrow('REFUND_ALREADY_RESERVED');
  });

  it('commits and rehydrates a paid-service order aggregate', async () => {
    const suffix = randomUUID();
    const store = new PgPaidServiceOrderStore(app);
    await store.save({
      tenantId: 'northwind-synthetic',
      purchaseKey: `purchase-db-${suffix}`,
      requestHash: 'e'.repeat(64),
      occurredAt: '2026-04-01T12:00:00Z',
      order: {
        tenantId: 'northwind-synthetic',
        orderId: `order-db-${suffix}`,
        buyerRef: 'buyer-db',
        memberRef: 'member-db',
        offer: {
          tenantId: 'northwind-synthetic',
          catalogVersionRef: 'catalog-paid-service-v1',
          offerVersionRef: 'offer-paid-service-v1',
          opaqueProcessorSkuRef: 'sku-opaque-ps-v1',
          amountMinor: 5000,
          currency: 'USD',
          expiresAt: '2027-01-01T00:00:00Z',
          componentLines: [],
          cancellationPolicyRef: 'policy-cancel-v1',
          refundPolicyRef: 'policy-refund-v1',
          synthetic: true,
        },
        state: 'reconciled',
        ledgerReceipt: {
          tenantId: 'northwind-synthetic',
          journalId: `journal-db-${suffix}`,
          canonicalPayloadHash: 'f'.repeat(64),
        },
        entitlementEvents: [],
        fulfillment: [],
      },
    });
    expect((await store.load('northwind-synthetic', `purchase-db-${suffix}`))?.order.orderId).toBe(
      `order-db-${suffix}`,
    );
  });

  it('supports forward, reverse-dependency rollback, then forward migration replay', async () => {
    for (const file of [
      'modules/catalog-cash/migrations/0021-paid-service.rollback.sql',
      'modules/membership-entitlements/migrations/0020-entitlement-ledger.rollback.sql',
      'modules/payments-ledger/migrations/0019-cash-ledger.rollback.sql',
    ]) {
      await owner.query(readFileSync(`${root}${file}`, 'utf8'));
    }
    const removed = await owner.query(
      `SELECT to_regnamespace('catalog_cash') AS catalog,
              to_regnamespace('membership_entitlements') AS membership,
              to_regnamespace('payments_ledger') AS payments`,
    );
    expect(removed.rows[0]).toEqual({ catalog: null, membership: null, payments: null });
    for (const file of [
      'modules/payments-ledger/migrations/0019-cash-ledger.sql',
      'modules/membership-entitlements/migrations/0020-entitlement-ledger.sql',
      'modules/catalog-cash/migrations/0021-paid-service.sql',
    ]) {
      await owner.query(readFileSync(`${root}${file}`, 'utf8'));
    }
    const restored = await owner.query(
      `SELECT to_regclass('payments_ledger.journal') AS journal,
              to_regclass('membership_entitlements.entitlement_event') AS entitlement,
              to_regclass('catalog_cash.paid_service_order') AS paid_order`,
    );
    expect(restored.rows[0]).toEqual({
      journal: 'payments_ledger.journal',
      entitlement: 'membership_entitlements.entitlement_event',
      paid_order: 'catalog_cash.paid_service_order',
    });
  });
});
