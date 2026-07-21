/**
 * Drift gates (WP-020): the committed migration embeds EXACTLY the generated
 * RLS section; the guard registry declares every DDL-scope table; the
 * committed seed file embeds EXACTLY the generated audit seed section; and
 * the seeded chain data verifies before it ever reaches a database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { verifyAuditChain } from './audit.js';
import { auditEvidenceRlsSpecs, auditEvidenceSchemaRlsSpecs } from './rls-specs.js';
import {
  extractAuditSeedSection,
  renderAuditSeedSection,
  syntheticAuditSeedV1,
} from './seed-data.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0007-audit.sql RLS drift gate', () => {
  it('embeds exactly the generated section', () => {
    const migration = readFileSync(
      `${repoRoot}modules/audit-evidence/migrations/0007-audit.sql`,
      'utf8',
    );
    const embedded = extractRlsMigrationSection(migration);
    expect(embedded).toBe(
      renderRlsMigrationSection(
        'audit_evidence',
        auditEvidenceRlsSpecs,
        auditEvidenceSchemaRlsSpecs,
      ),
    );
  });

  it('the schema-wide guard registry declares every DDL-scope table', () => {
    const guardTables = new Set(
      auditEvidenceSchemaRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`),
    );
    for (const spec of auditEvidenceRlsSpecs) {
      expect(guardTables.has(`${spec.schema}.${spec.table}`)).toBe(true);
    }
  });
});

describe('009-audit-seed.sql drift gate', () => {
  it('embeds exactly the generated section', () => {
    const seed = readFileSync(`${repoRoot}infra/postgres/seed/009-audit-seed.sql`, 'utf8');
    const embedded = extractAuditSeedSection(seed);
    expect(embedded).toBe(renderAuditSeedSection(syntheticAuditSeedV1));
  });

  it('the seed data of record hash-verifies before it reaches a database', () => {
    const verification = verifyAuditChain(syntheticAuditSeedV1.records);
    expect(verification.breaks).toEqual([]);
    expect(verification.valid).toBe(true);
  });

  it('seed destruction evidence is internally consistent with its audit record', () => {
    for (const evidence of syntheticAuditSeedV1.destructionEvidence) {
      const auditRecord = syntheticAuditSeedV1.records.find(
        (record) => record.tenantId === evidence.tenantId && record.auditId === evidence.auditId,
      );
      expect(auditRecord, evidence.destructionId).toBeDefined();
      expect(auditRecord?.action).toBe('destruction-executed');
      expect(auditRecord?.detail?.['manifest_hash']).toBe(evidence.manifestHash);
    }
  });

  it('the seeded ACTIVE hold never covers a class the seed destroyed', () => {
    for (const evidence of syntheticAuditSeedV1.destructionEvidence) {
      for (const hold of syntheticAuditSeedV1.holds) {
        if (hold.status !== 'active' || hold.tenantId !== evidence.tenantId) {
          continue;
        }
        const covers =
          hold.recordClasses.length === 0 || hold.recordClasses.includes(evidence.recordClass);
        expect(covers, `${hold.holdId} vs ${evidence.destructionId}`).toBe(false);
      }
    }
  });
});
