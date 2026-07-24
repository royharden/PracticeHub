/**
 * WP-025 records-domain unit suite. Proves the verification-gate surfaces at the
 * domain level against REAL cross-module engines:
 *  - supersession (REQ-DOC-003): a correction preserves the source; a denied
 *    correction lands a statement of disagreement and the source stays current;
 *  - e-sign closure (D5.4): only a signed outcome becomes a version;
 *  - partition-scoped search negatives (REQ-DOC-013/016): a genetic doc never
 *    surfaces without genetic clearance, cross-tenant never surfaces;
 *  - records export (REQ-DOC-002/013/016): scope limits + the SEND-TIME genetic
 *    re-check run through the REAL WP-015 assembleRecordsExport (FWD-PDP-025);
 *    the disclosure audit input emits through the REAL WP-020 emitter;
 *  - destruction over the REAL WP-020 retention engine (FWD-DOC-025/FWD-AUD-025):
 *    an expired clock yields evidence, an active hold suspends, a running clock
 *    refuses.
 */
import {
  emitAuditEvent,
  emptyChainState,
  retentionScheduleV1,
  type LegalHold,
} from '@practicehub/audit-evidence';
import type { PersonId } from '@practicehub/contracts';
import { assembleRecordsExport, type GipaAuthorization } from '@practicehub/identity';
import { jurisdictionPacksV1 } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { blobRefFor, contentByteLength, hashContent } from './blob.js';
import type { PartitionTag } from './document.js';
import type { SignatureEvidence } from './esign-port.js';
import {
  appendDocumentVersion,
  closeDisclosure,
  compileRecordsDisclosure,
  currentVersion,
  disclosureAuditInput,
  executeDocumentDestruction,
  planDocumentDestruction,
  scopedSearch,
  versionLineage,
  type DocumentVersion,
  type DocumentVersionInput,
  type GeneticExportAuthorization,
  type RecordsExportGuard,
  type RecordsExportItem,
  type RecordsRequest,
  type SearchIndexEntry,
} from './records.js';

const tenant = 'northwind-synthetic';

function versionInput(
  overrides: Partial<DocumentVersionInput> & { versionEventId: string },
): DocumentVersionInput {
  const content = overrides.contentHash
    ? ''
    : `synthetic-document-bytes:${overrides.versionEventId}`;
  const hash = overrides.contentHash ?? hashContent(content);
  return {
    tenantId: tenant,
    documentId: 'nd-v-0001',
    versionNo: 1,
    kind: 'original',
    blobRef: blobRefFor(hash),
    contentHash: hash,
    contentBytes: content === '' ? 10 : contentByteLength(content),
    mediaType: 'application/pdf',
    actorRef: 'synthetic-staff:records-clerk-001',
    occurredAt: '2026-03-01T10:00:00Z',
    synthetic: true,
    ...overrides,
  };
}

function original(): readonly DocumentVersion[] {
  return appendDocumentVersion(
    [],
    versionInput({ versionEventId: 'v1', versionNo: 1, kind: 'original' }),
  ).versions;
}

describe('versioning + supersession (REQ-DOC-003)', () => {
  it('a correction supersedes the source, and the SOURCE IS PRESERVED in the lineage', () => {
    const withOriginal = original();
    const { versions } = appendDocumentVersion(
      withOriginal,
      versionInput({
        versionEventId: 'v2',
        versionNo: 2,
        kind: 'correction',
        supersedesVersionNo: 1,
        reasonRef: 'synthetic-correction-request:wrong-dob',
      }),
    );
    const lineage = versionLineage(versions, tenant, 'nd-v-0001');
    expect(lineage.map((v) => v.versionNo)).toEqual([1, 2]);
    // the source (v1) still exists and is now superseded; the correction is current
    expect(lineage[0]?.superseded).toBe(true);
    expect(currentVersion(versions)?.versionNo).toBe(2);
    expect(currentVersion(versions)?.kind).toBe('correction');
  });

  it('a DENIED correction lands a statement of disagreement; the source stays current', () => {
    const withOriginal = original();
    const { versions } = appendDocumentVersion(
      withOriginal,
      versionInput({
        versionEventId: 'v2',
        versionNo: 2,
        kind: 'statement-of-disagreement',
        concernsVersionNo: 1,
      }),
    );
    // the disagreement is preserved but does not supersede — v1 is still current
    expect(currentVersion(versions)?.versionNo).toBe(1);
    expect(versionLineage(versions, tenant, 'nd-v-0001')).toHaveLength(2);
  });

  it('refuses a second original, a superseding version without a head, and a reasonless correction', () => {
    expect(() =>
      appendDocumentVersion(
        original(),
        versionInput({ versionEventId: 'v1b', versionNo: 1, kind: 'original' }),
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      appendDocumentVersion(
        [],
        versionInput({
          versionEventId: 'v2',
          versionNo: 2,
          kind: 'amendment',
          supersedesVersionNo: 1,
        }),
      ),
    ).toThrow(/no original version/);
    expect(() =>
      appendDocumentVersion(
        original(),
        versionInput({
          versionEventId: 'v2',
          versionNo: 2,
          kind: 'correction',
          supersedesVersionNo: 1,
        }),
      ),
    ).toThrow(/records its reason/);
  });

  it('a superseding version must target the CURRENT head, not a stale one', () => {
    const withCorrection = appendDocumentVersion(
      original(),
      versionInput({
        versionEventId: 'v2',
        versionNo: 2,
        kind: 'correction',
        supersedesVersionNo: 1,
        reasonRef: 'synthetic-ref:a',
      }),
    ).versions;
    expect(() =>
      appendDocumentVersion(
        withCorrection,
        versionInput({
          versionEventId: 'v3',
          versionNo: 3,
          kind: 'amendment',
          supersedesVersionNo: 1,
        }),
      ),
    ).toThrow(/supersede the current head/);
  });
});

describe('e-sign artifacts (D5.4) — transmission is not closure', () => {
  const signed: SignatureEvidence = {
    requestId: 'esr-0001',
    tenantId: tenant,
    documentId: 'nd-v-0001',
    versionNo: 2,
    status: 'signed',
    signerRefs: ['synthetic-patient:np-sam-porter'],
    method: 'click-to-sign',
    certificateHash: hashContent('synthetic-cert:esr-0001'),
    signedAt: '2026-03-09T08:30:00Z',
    evidenceRef: 'synthetic-esign-evidence:esr-0001',
    synthetic: true,
  };

  it('a signed outcome becomes an esign-execution version carrying its evidence chain', () => {
    const { version } = appendDocumentVersion(
      original(),
      versionInput({
        versionEventId: 'v2',
        versionNo: 2,
        kind: 'esign-execution',
        supersedesVersionNo: 1,
        signature: signed,
      }),
    );
    expect(version.signature?.certificateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(version.kind).toBe('esign-execution');
  });

  it('a PENDING signature is not closure — it never becomes a version', () => {
    const pending: SignatureEvidence = {
      requestId: 'esr-0001',
      tenantId: tenant,
      documentId: 'nd-v-0001',
      versionNo: 2,
      status: 'pending',
      signerRefs: ['synthetic-patient:np-sam-porter'],
      method: 'click-to-sign',
      synthetic: true,
    };
    expect(() =>
      appendDocumentVersion(
        original(),
        versionInput({
          versionEventId: 'v2',
          versionNo: 2,
          kind: 'esign-execution',
          supersedesVersionNo: 1,
          signature: pending,
        }),
      ),
    ).toThrow(/transmission is not closure/);
  });

  it('only an esign-execution version may carry signature evidence', () => {
    expect(() =>
      appendDocumentVersion(
        original(),
        versionInput({
          versionEventId: 'v2',
          versionNo: 2,
          kind: 'amendment',
          supersedesVersionNo: 1,
          signature: signed,
        }),
      ),
    ).toThrow(/only an esign-execution/);
  });
});

describe('partition/PDP-scoped search (REQ-DOC-013/016)', () => {
  const geneticDoc: SearchIndexEntry = {
    tenantId: tenant,
    documentId: 'nd-0007',
    versionNo: 1,
    docType: 'genetic-panel-result',
    searchTerms: 'hereditary panel genetic sequencing report',
    partitionTags: ['gipa-genetic'],
    segments: ['clinical'],
  };
  const clinicalDoc: SearchIndexEntry = {
    tenantId: tenant,
    documentId: 'nd-0001',
    versionNo: 2,
    docType: 'referral-summary',
    searchTerms: 'cardiology referral consult',
    partitionTags: [],
    segments: ['clinical'],
  };
  const index = [geneticDoc, clinicalDoc];

  it('a caller WITHOUT genetic clearance never surfaces a genetic document (negative)', () => {
    const results = scopedSearch(index, 'panel', {
      tenantId: tenant,
      partitionClearances: [],
      segmentClearances: ['clinical'],
    });
    expect(results.map((r) => r.documentId)).not.toContain('nd-0007');
  });

  it('a caller WITH genetic clearance surfaces it (positive control)', () => {
    const results = scopedSearch(index, 'panel', {
      tenantId: tenant,
      partitionClearances: ['gipa-genetic'] as readonly PartitionTag[],
      segmentClearances: ['clinical'],
    });
    expect(results.map((r) => r.documentId)).toContain('nd-0007');
  });

  it('a document outside the caller segment clearance never surfaces', () => {
    const results = scopedSearch(index, 'referral', {
      tenantId: tenant,
      partitionClearances: [],
      segmentClearances: ['billing'],
    });
    expect(results).toHaveLength(0);
  });

  it('a cross-tenant caller surfaces nothing', () => {
    const results = scopedSearch(index, 'referral', {
      tenantId: 'riverbend-synthetic',
      partitionClearances: ['gipa-genetic'] as readonly PartitionTag[],
      segmentClearances: ['clinical'],
    });
    expect(results).toHaveLength(0);
  });
});

describe('records export + disclosure accounting (REQ-DOC-002/013/016)', () => {
  const subject = 'np-sam-porter';
  // The REAL WP-015 assembleRecordsExport, wrapped as the injected guard —
  // this is the FWD-PDP-025-EXPORT discharge (send-time genetic re-check).
  const guard: RecordsExportGuard = (req) => {
    const assembly = assembleRecordsExport({
      items: req.items.map((item) => ({
        artifactRef: item.artifactRef,
        partitionTags: item.partitionTags,
      })),
      subjectPersonId: req.subjectPersonRef as unknown as PersonId,
      authorizations: req.authorizations.map((a): GipaAuthorization => ({
        authorizationId: a.authorizationId,
        tenantId: tenant,
        subjectPersonId: req.subjectPersonRef as unknown as PersonId,
        scopeRef: 'synthetic-scope:genetic-records',
        grantedOn: a.grantedOn,
        expiresOn: a.expiresOn,
        writtenEvidenceRef: a.writtenEvidenceRef,
        status: a.status,
        synthetic: true,
      })),
      sendDate: req.sendDate,
    });
    return {
      included: assembly.included,
      excludedGenetic: assembly.excludedGenetic,
      ...(assembly.geneticIncludedUnder !== undefined
        ? { geneticIncludedUnder: assembly.geneticIncludedUnder }
        : {}),
      authorizationCheckedAt: assembly.authorizationCheckedAt,
    };
  };

  const referral = blobRefFor(hashContent('nd-0001-v2'));
  const genetic = blobRefFor(hashContent('nd-0007-v1'));
  const outOfScopeBilling = blobRefFor(hashContent('nd-bill-0001'));
  const candidates: readonly RecordsExportItem[] = [
    { artifactRef: referral, partitionTags: [], segment: 'clinical' },
    { artifactRef: genetic, partitionTags: ['gipa-genetic'], segment: 'clinical' },
    { artifactRef: outOfScopeBilling, partitionTags: [], segment: 'billing' },
  ];

  function requestFor(sendDate: string): RecordsRequest {
    return {
      requestId: 'ndd-req-0001',
      tenantId: tenant,
      subjectPersonRef: subject,
      recipientRef: 'synthetic-auditor:state-board-0007',
      purpose: 'subpoena-audit',
      requestedBy: 'synthetic-staff:compliance-001',
      allowedSegments: ['clinical'],
      allowedPartitionTags: ['gipa-genetic'] as readonly PartitionTag[],
      sendDate,
      synthetic: true,
    };
  }

  it('scope limits exclude out-of-scope items and genetic is EXCLUDED without a send-time authorization', () => {
    const disclosure = compileRecordsDisclosure(requestFor('2026-03-15'), candidates, guard, []);
    expect(disclosure.includedArtifactRefs).toEqual([referral]);
    expect(disclosure.excludedOutOfScopeRefs).toEqual([outOfScopeBilling]);
    expect(disclosure.excludedGeneticRefs).toEqual([genetic]);
    expect(disclosure.geneticIncludedUnder).toBeUndefined();
    expect(disclosure.closureStatus).toBe('transmitted');
  });

  it('a valid dated UNEXPIRED authorization at send time includes genetic (send-time re-check)', () => {
    const auth: GeneticExportAuthorization = {
      authorizationId: 'gauth-0001',
      subjectPersonRef: subject,
      grantedOn: '2026-01-01',
      expiresOn: '2027-01-01',
      writtenEvidenceRef: 'synthetic-gipa-auth:signed-0001',
      status: 'active',
    };
    const disclosure = compileRecordsDisclosure(requestFor('2026-03-15'), candidates, guard, [
      auth,
    ]);
    expect(disclosure.includedArtifactRefs).toEqual([referral, genetic]);
    expect(disclosure.excludedGeneticRefs).toEqual([]);
    expect(disclosure.geneticIncludedUnder?.authorizationRef).toBe('gauth-0001');
  });

  it('an EXPIRED authorization at send time excludes genetic again (the re-check is at send time)', () => {
    const expired: GeneticExportAuthorization = {
      authorizationId: 'gauth-0002',
      subjectPersonRef: subject,
      grantedOn: '2025-01-01',
      expiresOn: '2026-02-01',
      writtenEvidenceRef: 'synthetic-gipa-auth:signed-0002',
      status: 'active',
    };
    const disclosure = compileRecordsDisclosure(requestFor('2026-03-15'), candidates, guard, [
      expired,
    ]);
    expect(disclosure.excludedGeneticRefs).toEqual([genetic]);
  });

  it('closure is a distinct evidenced step (transmission is not closure)', () => {
    const disclosure = compileRecordsDisclosure(requestFor('2026-03-15'), candidates, guard, []);
    const closed = closeDisclosure(disclosure, 'synthetic-disclosure-receipt:auditor-ack');
    expect(closed.closureStatus).toBe('closed-with-evidence');
    expect(closed.closureEvidenceRef).toBe('synthetic-disclosure-receipt:auditor-ack');
    expect(() => closeDisclosure(closed, 'synthetic-ref:again')).toThrow(/already closed/);
  });

  it('the disclosure emits a disclosure-stream audit record through the REAL emitter', () => {
    const disclosure = compileRecordsDisclosure(requestFor('2026-03-15'), candidates, guard, []);
    const emitted = emitAuditEvent(emptyChainState, {
      ...disclosureAuditInput(disclosure),
      auditId: 'fx-records-disclosure-0001',
    });
    expect(emitted.record.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(emitted.record.stream).toBe('disclosure');
  });
});

describe('destruction over the WP-020 retention engine (FWD-DOC-025 / FWD-AUD-025)', () => {
  const nvBasis = { providerState: 'NV', patientState: 'NV' } as const;
  const recordRefs = [blobRefFor(hashContent('nd-0001-v2'))];

  function facts(recordDate: string): Parameters<typeof planDocumentDestruction>[2] {
    return {
      tenantId: tenant,
      documentId: 'nd-0001',
      recordRefs,
      recordClass: 'clinical-record',
      recordDate,
      subjectMinor: false,
      jurisdictionBasis: nvBasis,
    };
  }

  const execution = {
    destructionId: 'ndx-0001',
    auditId: 'nax-0001',
    authorityRef: 'synthetic-staff:records-officer-001',
    executedBy: 'synthetic-staff:records-officer-001',
    occurredAt: '2026-03-20T00:00:00Z',
  };

  it('an expired clock yields destruction evidence with a manifest hash over the record refs', () => {
    const eligibility = planDocumentDestruction(
      jurisdictionPacksV1,
      retentionScheduleV1,
      facts('2010-01-01'),
      [],
      '2026-03-20',
    );
    expect(eligibility.eligible).toBe(true);
    const outcome = executeDocumentDestruction(eligibility, [], execution);
    expect(outcome.outcome).toBe('destroyed');
    if (outcome.outcome === 'destroyed') {
      expect(outcome.evidence.manifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.evidence.recordRefs).toEqual(recordRefs);
    }
  });

  it('an active legal hold placed after the scan SUSPENDS the destruction (race resolves to the hold)', () => {
    const eligibility = planDocumentDestruction(
      jurisdictionPacksV1,
      retentionScheduleV1,
      facts('2010-01-01'),
      [],
      '2026-03-20',
    );
    const lateHold: LegalHold = {
      holdId: 'th-late-0001',
      tenantId: tenant,
      matterRef: 'synthetic-matter:late',
      recordClasses: ['clinical-record'],
      status: 'active',
      placedBy: 'synthetic-staff:compliance-001',
      placedBasisRef: 'synthetic-hold-order:late',
      synthetic: true,
    };
    const outcome = executeDocumentDestruction(eligibility, [lateHold], execution);
    expect(outcome.outcome).toBe('suspended-by-hold');
  });

  it('a still-running clock refuses destruction outright', () => {
    const eligibility = planDocumentDestruction(
      jurisdictionPacksV1,
      retentionScheduleV1,
      facts('2026-01-01'),
      [],
      '2026-03-20',
    );
    expect(eligibility.eligible).toBe(false);
    const outcome = executeDocumentDestruction(eligibility, [], execution);
    expect(outcome.outcome).toBe('refused-clock-active');
  });
});
