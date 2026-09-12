import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PracticeHubIntakeAttemptAdapter, PracticeHubWorkItemAdapter } from './ports.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const config = {
  host: process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1',
  port: Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432'),
  database: 'practicehub',
};
const ownerConfig = { ...config, user: 'practicehub', password: 'practicehub_synthetic_local' };
const appConfig = {
  ...config,
  user: 'practicehub_app',
  password: 'practicehub_app_synthetic_local',
};
let owner: Client;
let app: Client;

async function bound(tenant: string, sql: string): Promise<Array<Record<string, unknown>>> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenant));
    const result = await app.query(sql);
    await app.query('ROLLBACK');
    return result.rows;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function failure(tenant: string, sql: string): Promise<string> {
  try {
    await bound(tenant, sql);
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error('expected SQL to fail');
}

async function transaction(
  tenant: string,
  statements: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenant));
    let rows: Array<Record<string, unknown>> = [];
    for (const statement of statements) rows = (await app.query(statement)).rows;
    await app.query('ROLLBACK');
    return rows;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function sequenceFailure(tenant: string, statements: readonly string[]): Promise<string> {
  try {
    await transaction(tenant, statements);
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error('expected SQL sequence to fail');
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  for (const path of [
    'modules/platform-core/migrations/0001-tenancy.sql',
    'modules/events/migrations/0010-events.sql',
    'modules/events/migrations/0012-workitems.sql',
    'modules/portal-intake/migrations/0024-portal-intake.sql',
    'infra/postgres/seed/003-tenancy-seed.sql',
    'infra/postgres/seed/025-portal-intake-seed.sql',
  ]) {
    await owner.query(readFileSync(`${repoRoot}${path}`, 'utf8'));
  }
  app = new Client(appConfig);
  await app.connect();
}, 60000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('portal intake live persistence gate', () => {
  it('fails closed when unbound and prevents a tenant-forged definition', async () => {
    const rows = await app.query('SELECT count(*)::int AS n FROM portal_intake.intake_definition');
    expect((rows.rows[0] as { n: number }).n).toBe(0);
    expect(
      await failure(
        'northwind-synthetic',
        `INSERT INTO portal_intake.intake_definition
      (tenant_id,definition_id,version,effective_at,privacy_notice_ref,fields,synthetic)
      VALUES ('riverbend-synthetic','forged','2026-09-12',now(),'privacy-notice:synthetic-v1','[]',true)`,
      ),
    ).toBe('42501');
  });

  it('structurally rejects a health answer before granted collection consent', async () => {
    expect(
      await sequenceFailure('northwind-synthetic', [
        `INSERT INTO portal_intake.intake_submission
        (tenant_id,intake_ref,prospect_ref,definition_id,definition_version,status,work_item_ref,response_due_at,submitted_at,last_event_id,synthetic)
      VALUES ('northwind-synthetic','db-intake-001','db-prospect-001','prospective-intake','2026-09-12','submitted','wi-db-intake-001',now(),now(),'db-submitted-001',true)`,
        `INSERT INTO portal_intake.intake_answer
        (tenant_id,answer_id,intake_ref,field_id,answer_value,respondent_ref,respondent_role,source_channel,captured_at,synthetic)
      VALUES ('northwind-synthetic','db-answer-001','db-intake-001','health-goal','synthetic-value','db-prospect-001','prospect','primary-web',now(),true)`,
      ]),
    ).toBe('P0001');
  });

  it('refuses a cross-tenant append on the writable event log', async () => {
    expect(
      await failure(
        'northwind-synthetic',
        `INSERT INTO portal_intake.intake_event
          (tenant_id,event_id,intake_ref,prospect_ref,event_type,occurred_at,synthetic)
         VALUES ('riverbend-synthetic','db-forged-event','db-intake-x','db-prospect-x','abandoned',now(),true)`,
      ),
    ).toBe('42501');
  });

  it('accepts a health answer only after the exact granted collection event', async () => {
    const rows = await transaction('northwind-synthetic', [
      `INSERT INTO portal_intake.intake_submission
        (tenant_id,intake_ref,prospect_ref,definition_id,definition_version,status,work_item_ref,response_due_at,submitted_at,last_event_id,synthetic)
      VALUES ('northwind-synthetic','db-intake-002','db-prospect-002','prospective-intake','2026-09-12','submitted','wi-db-intake-002',now(),now(),'db-submitted-002',true)`,
      `INSERT INTO portal_intake.intake_event
        (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,embedding_origin,evidence_ref,evidence_hash,occurred_at,synthetic)
      VALUES ('northwind-synthetic','db-consent-002','db-intake-002','db-prospect-002','collection-consent-granted','quiz-collection','2026-09-12','privacy-v1','https://synthetic.test','evidence:db-consent-002','${'a'.repeat(64)}','2026-09-12T10:00:00Z',true)`,
      `INSERT INTO portal_intake.intake_answer
        (tenant_id,answer_id,intake_ref,field_id,answer_value,respondent_ref,respondent_role,source_channel,captured_at,synthetic)
      VALUES ('northwind-synthetic','db-answer-002','db-intake-002','health-goal','synthetic-value','db-prospect-002','prospect','primary-web','2026-09-12T10:00:01Z',true)`,
      `SELECT count(*)::int AS n FROM portal_intake.intake_answer WHERE intake_ref='db-intake-002'`,
    ]);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('rejects an answer not declared by the exact definition version', async () => {
    expect(
      await sequenceFailure('northwind-synthetic', [
        `INSERT INTO portal_intake.intake_submission
          (tenant_id,intake_ref,prospect_ref,definition_id,definition_version,status,work_item_ref,response_due_at,submitted_at,last_event_id,synthetic)
         VALUES ('northwind-synthetic','db-intake-003','db-prospect-003','prospective-intake','2026-09-12','submitted','wi-db-intake-003',now(),now(),'db-submitted-003',true)`,
        `INSERT INTO portal_intake.intake_event
          (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,embedding_origin,evidence_ref,evidence_hash,occurred_at,synthetic)
         VALUES ('northwind-synthetic','db-consent-003','db-intake-003','db-prospect-003','collection-consent-granted','quiz-collection','2026-09-12','privacy-v1','https://synthetic.test','evidence:db-consent-003','${'b'.repeat(64)}','2026-09-12T10:00:00Z',true)`,
        `INSERT INTO portal_intake.intake_answer
          (tenant_id,answer_id,intake_ref,field_id,answer_value,respondent_ref,respondent_role,source_channel,captured_at,synthetic)
         VALUES ('northwind-synthetic','db-answer-003','db-intake-003','undeclared-history','synthetic-value','db-prospect-003','prospect','primary-web','2026-09-12T10:00:01Z',true)`,
      ]),
    ).toBe('P0001');
  });

  it('rejects a fabricated subject link and ignores a valid link when selecting latest consent', async () => {
    expect(
      await sequenceFailure('northwind-synthetic', [
        `INSERT INTO portal_intake.intake_event
          (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,embedding_origin,evidence_ref,evidence_hash,occurred_at,synthetic)
         VALUES ('northwind-synthetic','db-consent-link','db-intake-link','db-prospect-link','collection-consent-granted','quiz-collection','2026-09-12','privacy-v1','https://synthetic.test','evidence:db-consent-link','${'d'.repeat(64)}','2026-09-12T10:00:00Z',true)`,
        `INSERT INTO portal_intake.intake_event
          (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,embedding_origin,evidence_ref,evidence_hash,governed_person_ref,source_event_id,occurred_at,synthetic)
         VALUES ('northwind-synthetic','db-link-forged','db-intake-link','db-prospect-link','subject-linked','quiz-collection','2026-09-12','privacy-v1','https://synthetic.test','evidence:changed','${'e'.repeat(64)}','person:synthetic-001','db-consent-link','2026-09-12T10:01:00Z',true)`,
      ]),
    ).toBe('P0001');

    const rows = await transaction('northwind-synthetic', [
      `INSERT INTO portal_intake.intake_submission
        (tenant_id,intake_ref,prospect_ref,definition_id,definition_version,status,work_item_ref,response_due_at,submitted_at,last_event_id,synthetic)
       VALUES ('northwind-synthetic','db-intake-link-ok','db-prospect-link-ok','prospective-intake','2026-09-12','submitted','wi-db-link-ok','2026-09-12T14:00:00Z','2026-09-12T10:00:00Z','db-submitted-link-ok',true)`,
      `INSERT INTO portal_intake.intake_event
        (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,embedding_origin,evidence_ref,evidence_hash,occurred_at,synthetic)
       VALUES ('northwind-synthetic','db-consent-link-ok','db-intake-link-ok','db-prospect-link-ok','collection-consent-granted','quiz-collection','2026-09-12','privacy-v1','https://synthetic.test','evidence:db-consent-link-ok','${'f'.repeat(64)}','2026-09-12T10:00:00Z',true)`,
      `INSERT INTO portal_intake.intake_event
        (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,embedding_origin,evidence_ref,evidence_hash,governed_person_ref,source_event_id,occurred_at,synthetic)
       VALUES ('northwind-synthetic','db-link-ok','db-intake-link-ok','db-prospect-link-ok','subject-linked','quiz-collection','2026-09-12','privacy-v1','https://synthetic.test','evidence:db-consent-link-ok','${'f'.repeat(64)}','person:synthetic-001','db-consent-link-ok','2026-09-12T10:01:00Z',true)`,
      `INSERT INTO portal_intake.intake_answer
        (tenant_id,answer_id,intake_ref,field_id,answer_value,respondent_ref,respondent_role,source_channel,captured_at,synthetic)
       VALUES ('northwind-synthetic','db-answer-link-ok','db-intake-link-ok','health-goal','synthetic-value','db-prospect-link-ok','prospect','primary-web','2026-09-12T10:02:00Z',true)`,
      `SELECT count(*)::int AS n FROM portal_intake.intake_answer WHERE intake_ref='db-intake-link-ok'`,
    ]);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('rejects NULL subject-link metadata and immutable submission retargeting', async () => {
    expect(
      await sequenceFailure('northwind-synthetic', [
        `INSERT INTO portal_intake.intake_event
          (tenant_id,event_id,intake_ref,prospect_ref,event_type,purpose,quiz_version,notice_version,embedding_origin,evidence_ref,evidence_hash,occurred_at,synthetic)
         VALUES ('northwind-synthetic','db-consent-null','db-intake-null','db-prospect-null','collection-consent-granted','quiz-collection','2026-09-12','privacy-v1','https://synthetic.test','evidence:db-consent-null','${'9'.repeat(64)}','2026-09-12T10:00:00Z',true)`,
        `INSERT INTO portal_intake.intake_event
          (tenant_id,event_id,intake_ref,prospect_ref,event_type,evidence_ref,evidence_hash,governed_person_ref,source_event_id,occurred_at,synthetic)
         VALUES ('northwind-synthetic','db-link-null','db-intake-null','db-prospect-null','subject-linked','evidence:db-consent-null','${'9'.repeat(64)}','person:synthetic-001','db-consent-null','2026-09-12T10:01:00Z',true)`,
      ]),
    ).toBe('P0001');
    expect(
      await sequenceFailure('northwind-synthetic', [
        `INSERT INTO portal_intake.intake_submission
          (tenant_id,intake_ref,prospect_ref,definition_id,definition_version,status,work_item_ref,response_due_at,submitted_at,last_event_id,synthetic)
         VALUES ('northwind-synthetic','db-intake-immutable','db-prospect-immutable','prospective-intake','2026-09-12','submitted','wi-db-immutable','2026-09-12T14:00:00Z','2026-09-12T10:00:00Z','db-submitted-immutable',true)`,
        `UPDATE portal_intake.intake_submission SET prospect_ref='db-prospect-retargeted'
          WHERE intake_ref='db-intake-immutable'`,
      ]),
    ).toBe('42501');
  });

  it('rolls back WP-022 work and attempt receipt together, then reconstructs after retry', async () => {
    const workInput = {
      tenantId: 'northwind-synthetic',
      intakeRef: 'db-intake-rollback',
      purpose: 'prospective-intake' as const,
      risk: 'routine' as const,
      responseDueAt: '2026-09-12T14:00:00Z',
      ownerRef: 'synthetic-guide:intake',
      poolRef: 'prospect-intake',
      occurredAt: '2026-09-12T10:00:00Z',
    };
    await app.query('BEGIN');
    await app.query(tenantBindingSql('northwind-synthetic'));
    await new PracticeHubIntakeAttemptAdapter(app, 'northwind-synthetic').save({
      attemptKey: 'db-attempt-rollback',
      inputHash: 'c'.repeat(64),
      consentEventId: 'db-consent-rollback',
      attachments: [],
      state: 'uploads-reconciled',
      synthetic: true,
    });
    await new PracticeHubWorkItemAdapter(app).open(workInput);
    await app.query('ROLLBACK');

    await app.end();
    app = new Client(appConfig);
    await app.connect();

    await app.query('BEGIN');
    await app.query(tenantBindingSql('northwind-synthetic'));
    expect(
      await new PracticeHubIntakeAttemptAdapter(app, 'northwind-synthetic').load(
        'db-attempt-rollback',
      ),
    ).toBeNull();
    expect((await new PracticeHubWorkItemAdapter(app).open(workInput)).workItemRef).toMatch(
      /^wi-portal-/,
    );
    await app.query('ROLLBACK');
  });

  it('refuses raw upload bytes smuggled into a durable attempt receipt', async () => {
    expect(
      await failure(
        'northwind-synthetic',
        `INSERT INTO portal_intake.intake_attempt
          (tenant_id,attempt_key,input_hash,consent_event_id,attachment_receipts,state,synthetic)
         VALUES ('northwind-synthetic','db-attempt-raw','${'8'.repeat(64)}','db-consent-raw',
           '[{"documentRef":"doc-raw","blobRef":"blob://documents/${'7'.repeat(64)}","contentHash":"${'7'.repeat(64)}","observedAttributeNames":[],"bytes":"synthetic-secret"}]'::jsonb,
           'consented',true)`,
      ),
    ).toBe('P0001');
  });

  it('refuses JSON null receipt metadata and same-length receipt replacement', async () => {
    expect(
      await failure(
        'northwind-synthetic',
        `INSERT INTO portal_intake.intake_attempt
          (tenant_id,attempt_key,input_hash,consent_event_id,attachment_receipts,state,synthetic)
         VALUES ('northwind-synthetic','db-attempt-null','${'6'.repeat(64)}','db-consent-null-receipt',
           '[{"documentRef":null,"blobRef":"blob://documents/${'5'.repeat(64)}","contentHash":"${'5'.repeat(64)}","observedAttributeNames":[null]}]'::jsonb,
           'consented',true)`,
      ),
    ).toBe('P0001');

    await app.query('BEGIN');
    await app.query(tenantBindingSql('northwind-synthetic'));
    const adapter = new PracticeHubIntakeAttemptAdapter(app, 'northwind-synthetic');
    const original = {
      attemptKey: 'db-attempt-prefix',
      inputHash: '4'.repeat(64),
      consentEventId: 'db-consent-prefix',
      attachments: [
        {
          documentRef: 'doc-prefix-a',
          blobRef: `blob://documents/${'3'.repeat(64)}`,
          contentHash: '3'.repeat(64),
          observedAttributeNames: ['patient-name'],
        },
      ],
      state: 'uploads-reconciled' as const,
      synthetic: true as const,
    };
    await adapter.save(original);
    await expect(
      adapter.save({
        ...original,
        attachments: [
          {
            documentRef: 'doc-prefix-b',
            blobRef: `blob://documents/${'2'.repeat(64)}`,
            contentHash: '2'.repeat(64),
            observedAttributeNames: ['patient-name'],
          },
        ],
      }),
    ).rejects.toThrow(/changed input|receipt/);
    const originalReceipt = original.attachments[0];
    if (originalReceipt === undefined) throw new Error('test receipt missing');
    await expect(
      adapter.save({
        ...original,
        attachments: [
          {
            ...originalReceipt,
            observedAttributeNames: ['patient-name', 'mrn'],
          },
        ],
      }),
    ).rejects.toThrow(/immutable/);
    await app.query('ROLLBACK');
  });

  it('survives an idempotent forward, rollback, and clean forward recovery', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/portal-intake/migrations/0024-portal-intake.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(
        `${repoRoot}modules/portal-intake/migrations/0024-portal-intake.rollback.sql`,
        'utf8',
      ),
    );
    const rolledBack = await owner.query(
      `SELECT to_regclass('portal_intake.intake_submission') AS relation`,
    );
    expect(rolledBack.rows[0]?.['relation']).toBeNull();

    await owner.query(
      readFileSync(`${repoRoot}modules/portal-intake/migrations/0024-portal-intake.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}infra/postgres/seed/025-portal-intake-seed.sql`, 'utf8'),
    );
    const recovered = await bound(
      'northwind-synthetic',
      `SELECT count(*)::int AS n FROM portal_intake.intake_definition`,
    );
    expect((recovered[0] as { n: number }).n).toBeGreaterThan(0);
  });
});
