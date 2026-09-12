import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const host = process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1';
const port = Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432');
const ownerConfig = {
  host,
  port,
  database: 'practicehub',
  user: 'practicehub',
  password: 'practicehub_synthetic_local',
};
const appConfig = {
  host,
  port,
  database: 'practicehub',
  user: 'practicehub_app',
  password: 'practicehub_app_synthetic_local',
};
let owner: Client;
let app: Client;

async function boundQuery(
  tenantId: string,
  text: string,
): Promise<readonly Record<string, unknown>[]> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(text);
    await app.query('ROLLBACK');
    return result.rows;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  app = new Client(appConfig);
  await owner.connect();
  await owner.query(
    readFileSync(`${repoRoot}modules/ai-gateway/migrations/0023-ai-gateway.sql`, 'utf8'),
  );
  await owner.query(readFileSync(`${repoRoot}infra/postgres/seed/024-ai-gateway-seed.sql`, 'utf8'));
  await app.connect();
}, 60000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('ai_gateway database boundaries', () => {
  it('fails closed for unbound reads and hides Riverbend from Northwind', async () => {
    const unbound = await app.query('SELECT count(*)::int AS n FROM ai_gateway.model_binding');
    expect((unbound.rows[0] as { n: number }).n).toBe(0);
    const cross = await boundQuery(
      'northwind-synthetic',
      "SELECT count(*)::int AS n FROM ai_gateway.model_binding WHERE tenant_id = 'riverbend-synthetic'",
    );
    expect((cross[0] as { n: number }).n).toBe(0);
  });

  it('seeds one exact Northwind dev binding while Riverbend remains empty', async () => {
    const northwind = await boundQuery(
      'northwind-synthetic',
      `SELECT use_case,cohort_ref,mode,enabled,synthetic FROM ai_gateway.model_binding`,
    );
    expect(northwind).toEqual([
      {
        use_case: 'draft-visit-summary',
        cohort_ref: 'cohort-alpha',
        mode: 'dev',
        enabled: true,
        synthetic: true,
      },
    ]);
    const riverbend = await boundQuery(
      'riverbend-synthetic',
      'SELECT * FROM ai_gateway.model_binding',
    );
    expect(riverbend).toEqual([]);
  });

  it('refuses a forged cross-tenant write under forced RLS', async () => {
    await expect(
      boundQuery(
        'northwind-synthetic',
        `INSERT INTO ai_gateway.model_binding
       (tenant_id,use_case,cohort_ref,binding_ref,vendor_id,model_ref,pinned_model_version,
        prompt_template_version,system_policy_ref,version,mode,enabled,synthetic)
       VALUES ('riverbend-synthetic','draft-summary','cohort:x','binding:x','vendor:x','model:x',
        'model-api-v1','prompt-v1','policy:v1',1,'dev',false,true)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('makes prod mode and non-synthetic rows unrepresentable', async () => {
    await expect(
      boundQuery(
        'northwind-synthetic',
        `INSERT INTO ai_gateway.model_binding
       (tenant_id,use_case,cohort_ref,binding_ref,vendor_id,model_ref,pinned_model_version,
        prompt_template_version,system_policy_ref,version,mode,enabled,synthetic)
       VALUES ('northwind-synthetic','draft-summary','cohort:x','binding:x','vendor:x','model:x',
        'model-api-v1','prompt-v1','policy:v1',1,'prod',false,false)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps interaction evidence append-only at the module role', async () => {
    const privileges = await owner.query(
      `SELECT has_table_privilege('module_ai_gateway','ai_gateway.interaction','UPDATE') AS can_update,
              has_table_privilege('module_ai_gateway','ai_gateway.interaction','DELETE') AS can_delete`,
    );
    expect(privileges.rows[0]).toEqual({ can_update: false, can_delete: false });
  });

  it('reapplies the migration idempotently', async () => {
    await expect(
      owner.query(
        readFileSync(`${repoRoot}modules/ai-gateway/migrations/0023-ai-gateway.sql`, 'utf8'),
      ),
    ).resolves.toBeDefined();
  });
});
