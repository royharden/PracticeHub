/**
 * GIPA partition suites (WP-015; REQ-ID-019 — the IC-2 substance).
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  assembleRecordsExport,
  auditGeneticCoverage,
  breakGlassSeverityFor,
  classifyDataElement,
  employerSurfaceMetrics,
  findValidGipaAuthorization,
  geneticIngestionPaths,
  renderEmployerSurface,
  type EmployerSurfaceQuery,
  type GipaAuthorization,
} from './gipa.js';

const tenant = 'northwind-synthetic' as TenantId;
const subject = 'np-alex-rivera' as PersonId;

const activeAuthorization: GipaAuthorization = {
  authorizationId: 'nga-0001',
  tenantId: tenant,
  subjectPersonId: subject,
  scopeRef: 'synthetic-gipa-scope-life-insurer',
  grantedOn: '2026-02-01',
  expiresOn: '2027-02-01',
  writtenEvidenceRef: 'synthetic-gipa-written-0001',
  status: 'active',
  synthetic: true,
};

describe('classification at ingestion (AC-1/AC-4/EX-1)', () => {
  it('genetic element kinds tag into the partition class on every path', () => {
    for (const path of geneticIngestionPaths) {
      const outcome = classifyDataElement({
        kind: 'family-history',
        path,
        reliablyClassifiable: true,
      });
      expect(outcome.tagged).toBe(true);
      if (outcome.tagged) {
        expect(outcome.tag).toBe('gipa-genetic');
        expect(outcome.blockedFromRelease).toBe(false);
      }
    }
  });

  it('unreliable migrated data NEVER defaults to not-genetic — it quarantines (EX-1)', () => {
    const outcome = classifyDataElement({
      kind: 'legacy-unknown-field',
      path: 'migration-workbench',
      reliablyClassifiable: false,
    });
    expect(outcome.tagged).toBe(true);
    if (outcome.tagged) {
      expect(outcome.reviewStatus).toBe('needs-classification-review');
      expect(outcome.blockedFromRelease).toBe(true);
    }
  });

  it('a non-genetic, reliably classified element stays untagged', () => {
    expect(
      classifyDataElement({
        kind: 'blood-pressure',
        path: 'manual-entry',
        reliablyClassifiable: true,
      }).tagged,
    ).toBe(false);
  });

  it('the coverage audit confirms every ingestion path, not just one (AC-4)', () => {
    expect(auditGeneticCoverage([...geneticIngestionPaths]).complete).toBe(true);
    const partial = auditGeneticCoverage(['manual-entry', 'lab-interface']);
    expect(partial.complete).toBe(false);
    expect(partial.missingPaths).toEqual(['migration-workbench', 'pa-payload']);
  });
});

describe('records export — send-time recheck (AC-3/EX-2/EX-4)', () => {
  const items = [
    { artifactRef: 'synthetic-doc:visit-note-1', partitionTags: [] as const },
    { artifactRef: 'synthetic-lab-result:lr-9001', partitionTags: ['gipa-genetic'] as const },
  ];

  it('genetic is excluded by default when no valid authorization exists', () => {
    const assembly = assembleRecordsExport({
      items,
      subjectPersonId: subject,
      authorizations: [],
      sendDate: '2026-03-25',
    });
    expect(assembly.included.map((item) => item.artifactRef)).toEqual([
      'synthetic-doc:visit-note-1',
    ]);
    expect(assembly.excludedGenetic).toHaveLength(1);
    expect(assembly.authorizationCheckedAt).toBe('send-time');
  });

  it('validity is re-checked at SEND time, not request time (EX-2)', () => {
    const expiredAtSend: GipaAuthorization = { ...activeAuthorization, expiresOn: '2026-03-01' };
    // Valid when the request was made…
    expect(findValidGipaAuthorization([expiredAtSend], subject, '2026-02-15')).toBeDefined();
    // …expired by the send date: genetic is excluded, prior stands.
    const assembly = assembleRecordsExport({
      items,
      subjectPersonId: subject,
      authorizations: [expiredAtSend],
      sendDate: '2026-03-25',
    });
    expect(assembly.excludedGenetic).toHaveLength(1);
    expect(assembly.geneticIncludedUnder).toBeUndefined();
    expect(assembly.priorDisclosuresUnwound).toBe(false);
  });

  it('a specific, dated, written, unexpired authorization includes genetic with its reference', () => {
    const assembly = assembleRecordsExport({
      items,
      subjectPersonId: subject,
      authorizations: [activeAuthorization],
      sendDate: '2026-03-25',
    });
    expect(assembly.included).toHaveLength(2);
    expect(assembly.geneticIncludedUnder?.authorizationRef).toBe('nga-0001');
    expect(assembly.geneticIncludedUnder?.writtenEvidenceRef).toBe('synthetic-gipa-written-0001');
  });

  it('a revoked authorization never validates', () => {
    expect(
      findValidGipaAuthorization(
        [{ ...activeAuthorization, status: 'revoked' }],
        subject,
        '2026-03-25',
      ),
    ).toBeUndefined();
  });
});

describe('employer surface — structural exclusion (AC-2/AC-6/EX-3)', () => {
  const stats = {
    rosterHeadcount: 120,
    activeMembershipCount: 96,
    invoiceTotalCents: 4_800_000,
    tierBreakdown: { core: 60, plus: 36 },
  };

  it('the metric vocabulary is closed and contains no clinical or genetic member', () => {
    expect(employerSurfaceMetrics).toEqual([
      'roster-headcount',
      'active-membership-count',
      'invoice-total',
      'tier-breakdown',
    ]);
    for (const metric of employerSurfaceMetrics) {
      expect(metric).not.toMatch(/genetic|clinical|diagnos|utiliz/);
    }
  });

  it('renders only the closed metrics; an unknown metric is refused at runtime', () => {
    const query: EmployerSurfaceQuery = {
      tenantId: tenant,
      legalEntityId: 'northwind-health-nv' as never,
      metric: 'roster-headcount',
    };
    expect(renderEmployerSurface(query, stats)).toBe(120);
    expect(() =>
      renderEmployerSurface({ ...query, metric: 'genetic-summary' as never }, stats),
    ).toThrow('closed');
  });

  it('the query SHAPE cannot name genetic data — compile-time structural proof', () => {
    const impossible: EmployerSurfaceQuery = {
      tenantId: tenant,
      legalEntityId: 'northwind-health-nv' as never,
      metric: 'roster-headcount',
      // @ts-expect-error — there is no field through which a data segment
      // can be named on the employer query (REQ-ID-019 AC-2/AC-6).
      segment: 'genetic',
    };
    expect(impossible).toBeDefined();
  });
});

describe('break-glass severity (AC-8)', () => {
  it('genetic-touching events classify elevated-genetic — never blended into general volume', () => {
    expect(breakGlassSeverityFor(['gipa-genetic'])).toBe('elevated-genetic');
    expect(breakGlassSeverityFor(['chd'])).toBe('standard');
    expect(breakGlassSeverityFor([])).toBe('standard');
  });
});
