import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { auditPaiCoverage, renderAuditMarkdown } from './audit.js';
import { EXPECTED_PAI_IDS, loadCanonicalDocument } from './load-canonical.js';

describe('PAI coverage audit', () => {
  it('maps every PAI-01..20 onto at least one canonical requirement', () => {
    const document = loadCanonicalDocument();
    const audit = auditPaiCoverage(document.requirements);
    expect(document.count).toBe(document.requirements.length);
    expect(audit.uniquePaiIds).toEqual([...EXPECTED_PAI_IDS]);
    expect(audit.unmappedPaiIds).toEqual([]);
    expect(audit.unexpectedPaiIds).toEqual([]);
    expect(audit.allExpectedMapped).toBe(true);
    expect(audit.paiWithoutReqAi).toEqual(['PAI-08', 'PAI-10']);
    expect(audit.flaggedWithoutPai).toHaveLength(25);
    expect(audit.flaggedWithoutPai[0]).toBe('REQ-AI-047');
    expect(audit.flaggedWithoutPai[24]).toBe('REQ-AI-071');
    const report = renderAuditMarkdown(audit);
    const reportPath = resolve(dirname(fileURLToPath(import.meta.url)), '../reports/pai-coverage-audit.md');
    writeFileSync(reportPath, report, 'utf8');
    expect(report).toContain('WP-106/PAI-COVERAGE');
    expect(report).toContain('allExpectedMapped: true');
  });
});
