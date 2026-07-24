/**
 * Executable 4-class fixture packs for the WP-025 requirement slice:
 *   REQ-DOC-002 — lawful records request with disclosure proof;
 *   REQ-DOC-003 — patient correction without erasing the source record;
 *   REQ-DOC-013 — records scope selection, compilation, disclosure accounting;
 *   REQ-DOC-016 — subpoena/audit export with scope limits.
 * Every case runs against the REAL domain functions and the REAL WP-015
 * assembleRecordsExport guard (send-time genetic re-check) and WP-020 retention
 * engine — a fixture that merely "exists" without encoding its acceptance
 * criterion cannot pass here. The accepted-op list is validated at LOAD (an
 * unknown op fails the pack's structural test), and the dispatcher ends in a
 * throwing default (review-009 discipline).
 */
import { fileURLToPath } from 'node:url';

import { retentionScheduleV1 } from '@practicehub/audit-evidence';
import type { PersonId } from '@practicehub/contracts';
import { assembleRecordsExport, type GipaAuthorization } from '@practicehub/identity';
import { jurisdictionPacksV1 } from '@practicehub/platform-core';
import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { blobRefFor, contentByteLength, hashContent } from './blob.js';
import type { PartitionTag } from './document.js';
import {
  appendDocumentVersion,
  closeDisclosure,
  compileRecordsDisclosure,
  currentVersion,
  planDocumentDestruction,
  executeDocumentDestruction,
  scopedSearch,
  versionLineage,
  type DocumentVersion,
  type DocumentVersionInput,
  type GeneticExportAuthorization,
  type RecordSegment,
  type RecordsExportGuard,
  type RecordsExportItem,
  type RecordsRequest,
  type SearchIndexEntry,
} from './records.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const tenant = 'northwind-synthetic';

const acceptedOps = ['version', 'search', 'disclose', 'destroy'] as const;
type FixtureOp = (typeof acceptedOps)[number];

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

const ref = (token: string): string => blobRefFor(hashContent(token));

interface VersionSpec {
  readonly id: string;
  readonly versionNo: number;
  readonly kind: DocumentVersionInput['kind'];
  readonly supersedesVersionNo?: number;
  readonly concernsVersionNo?: number;
  readonly reasonRef?: string;
  readonly signed?: boolean;
}

interface IndexSpec {
  readonly documentId: string;
  readonly versionNo: number;
  readonly docType: string;
  readonly searchTerms: string;
  readonly partitionTags?: readonly PartitionTag[];
  readonly segments: readonly RecordSegment[];
}

interface CandidateSpec {
  readonly token: string;
  readonly partitionTags?: readonly PartitionTag[];
  readonly segment: RecordSegment;
}

interface AuthSpec {
  readonly grantedOn: string;
  readonly expiresOn: string;
}

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  // version
  readonly versions?: readonly VersionSpec[];
  readonly expectCurrentVersion?: number;
  readonly expectLineageLength?: number;
  readonly expectError?: string;
  // search
  readonly index?: readonly IndexSpec[];
  readonly query?: string;
  readonly clearancePartitions?: readonly PartitionTag[];
  readonly clearanceSegments?: readonly RecordSegment[];
  readonly clearanceTenant?: string;
  readonly expectDocIds?: readonly string[];
  // disclose
  readonly candidates?: readonly CandidateSpec[];
  readonly allowedSegments?: readonly RecordSegment[];
  readonly allowedPartitionTags?: readonly PartitionTag[];
  readonly authorization?: AuthSpec;
  readonly sendDate?: string;
  readonly expectIncludedTokens?: readonly string[];
  readonly expectExcludedGeneticTokens?: readonly string[];
  readonly expectExcludedOutOfScopeTokens?: readonly string[];
  readonly closeWith?: string;
  readonly expectClosure?: 'transmitted' | 'closed-with-evidence';
  // destroy
  readonly recordDate?: string;
  readonly asOf?: string;
  readonly withActiveHold?: boolean;
  readonly expectOutcome?: 'destroyed' | 'suspended-by-hold' | 'refused-clock-active';
}

interface RecordsFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function versionInput(spec: VersionSpec): DocumentVersionInput {
  const content = `synthetic-document-bytes:${spec.id}`;
  const hash = hashContent(content);
  return {
    versionEventId: spec.id,
    tenantId: tenant,
    documentId: 'nd-fx-rec',
    versionNo: spec.versionNo,
    kind: spec.kind,
    blobRef: blobRefFor(hash),
    contentHash: hash,
    contentBytes: contentByteLength(content),
    mediaType: 'application/pdf',
    ...(spec.supersedesVersionNo !== undefined
      ? { supersedesVersionNo: spec.supersedesVersionNo }
      : {}),
    ...(spec.concernsVersionNo !== undefined ? { concernsVersionNo: spec.concernsVersionNo } : {}),
    ...(spec.reasonRef !== undefined ? { reasonRef: spec.reasonRef } : {}),
    ...(spec.signed === true
      ? {
          signature: {
            requestId: `esr-${spec.id}`,
            tenantId: tenant,
            documentId: 'nd-fx-rec',
            versionNo: spec.versionNo,
            status: 'signed' as const,
            signerRefs: ['synthetic-patient:np-sam-porter'],
            method: 'click-to-sign' as const,
            certificateHash: hashContent(`cert:${spec.id}`),
            signedAt: '2026-03-09T08:30:00Z',
            evidenceRef: `synthetic-esign-evidence:${spec.id}`,
            synthetic: true as const,
          },
        }
      : {}),
    actorRef: 'synthetic-staff:records-clerk-001',
    occurredAt: '2026-03-05T10:00:00Z',
    synthetic: true,
  };
}

function runVersion(fixtureCase: FixtureCase): void {
  const specs = fixtureCase.versions ?? [];
  if (fixtureCase.expectError !== undefined) {
    expect(() => {
      let versions: readonly DocumentVersion[] = [];
      for (const spec of specs) {
        ({ versions } = appendDocumentVersion(versions, versionInput(spec)));
      }
    }).toThrow(fixtureCase.expectError);
    return;
  }
  let versions: readonly DocumentVersion[] = [];
  for (const spec of specs) {
    ({ versions } = appendDocumentVersion(versions, versionInput(spec)));
  }
  if (fixtureCase.expectCurrentVersion !== undefined) {
    expect(currentVersion(versions)?.versionNo).toBe(fixtureCase.expectCurrentVersion);
  }
  if (fixtureCase.expectLineageLength !== undefined) {
    expect(versionLineage(versions, tenant, 'nd-fx-rec')).toHaveLength(
      fixtureCase.expectLineageLength,
    );
  }
}

function runSearch(fixtureCase: FixtureCase): void {
  const index: readonly SearchIndexEntry[] = (fixtureCase.index ?? []).map((entry) => ({
    tenantId: tenant,
    documentId: entry.documentId,
    versionNo: entry.versionNo,
    docType: entry.docType,
    searchTerms: entry.searchTerms,
    partitionTags: entry.partitionTags ?? [],
    segments: entry.segments,
  }));
  const results = scopedSearch(index, fixtureCase.query ?? '', {
    tenantId: fixtureCase.clearanceTenant ?? tenant,
    partitionClearances: fixtureCase.clearancePartitions ?? [],
    segmentClearances: fixtureCase.clearanceSegments ?? [],
  });
  expect(results.map((r) => r.documentId).sort()).toEqual(
    [...(fixtureCase.expectDocIds ?? [])].sort(),
  );
}

function runDisclose(fixtureCase: FixtureCase): void {
  const candidates: readonly RecordsExportItem[] = (fixtureCase.candidates ?? []).map((c) => ({
    artifactRef: ref(c.token),
    partitionTags: c.partitionTags ?? [],
    segment: c.segment,
  }));
  const authorizations: readonly GeneticExportAuthorization[] =
    fixtureCase.authorization !== undefined
      ? [
          {
            authorizationId: 'gauth-fx-0001',
            subjectPersonRef: 'np-sam-porter',
            grantedOn: fixtureCase.authorization.grantedOn,
            expiresOn: fixtureCase.authorization.expiresOn,
            writtenEvidenceRef: 'synthetic-gipa-auth:signed-fx',
            status: 'active',
          },
        ]
      : [];
  const request: RecordsRequest = {
    requestId: 'ndd-fx-0001',
    tenantId: tenant,
    subjectPersonRef: 'np-sam-porter',
    recipientRef: 'synthetic-auditor:state-board-0007',
    purpose: 'subpoena-audit',
    requestedBy: 'synthetic-staff:compliance-001',
    allowedSegments: fixtureCase.allowedSegments ?? ['clinical'],
    allowedPartitionTags: fixtureCase.allowedPartitionTags ?? [],
    sendDate: fixtureCase.sendDate ?? '2026-03-15',
    synthetic: true,
  };
  let disclosure = compileRecordsDisclosure(request, candidates, guard, authorizations);
  if (fixtureCase.expectIncludedTokens !== undefined) {
    expect([...disclosure.includedArtifactRefs].sort()).toEqual(
      fixtureCase.expectIncludedTokens.map(ref).sort(),
    );
  }
  if (fixtureCase.expectExcludedGeneticTokens !== undefined) {
    expect([...disclosure.excludedGeneticRefs].sort()).toEqual(
      fixtureCase.expectExcludedGeneticTokens.map(ref).sort(),
    );
  }
  if (fixtureCase.expectExcludedOutOfScopeTokens !== undefined) {
    expect([...disclosure.excludedOutOfScopeRefs].sort()).toEqual(
      fixtureCase.expectExcludedOutOfScopeTokens.map(ref).sort(),
    );
  }
  if (fixtureCase.closeWith !== undefined) {
    disclosure = closeDisclosure(disclosure, fixtureCase.closeWith);
  }
  if (fixtureCase.expectClosure !== undefined) {
    expect(disclosure.closureStatus).toBe(fixtureCase.expectClosure);
  }
}

function runDestroy(fixtureCase: FixtureCase): void {
  const eligibility = planDocumentDestruction(
    jurisdictionPacksV1,
    retentionScheduleV1,
    {
      tenantId: tenant,
      documentId: 'nd-fx-rec',
      recordRefs: [ref('nd-fx-rec-v1')],
      recordClass: 'clinical-record',
      recordDate: fixtureCase.recordDate ?? '2010-01-01',
      subjectMinor: false,
      jurisdictionBasis: { providerState: 'NV', patientState: 'NV' },
    },
    [],
    fixtureCase.asOf ?? '2026-03-20',
  );
  const holds =
    fixtureCase.withActiveHold === true
      ? [
          {
            holdId: 'th-fx-0001',
            tenantId: tenant,
            matterRef: 'synthetic-matter:fx',
            recordClasses: ['clinical-record'] as const,
            status: 'active' as const,
            placedBy: 'synthetic-staff:compliance-001',
            placedBasisRef: 'synthetic-hold-order:fx',
            synthetic: true as const,
          },
        ]
      : [];
  const outcome = executeDocumentDestruction(eligibility, holds, {
    destructionId: 'ndx-fx-0001',
    auditId: 'nax-fx-0001',
    authorityRef: 'synthetic-staff:records-officer-001',
    executedBy: 'synthetic-staff:records-officer-001',
    occurredAt: '2026-03-20T00:00:00Z',
  });
  if (fixtureCase.expectOutcome !== undefined) {
    expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
  }
}

function runCase(fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'version':
      runVersion(fixtureCase);
      break;
    case 'search':
      runSearch(fixtureCase);
      break;
    case 'disclose':
      runDisclose(fixtureCase);
      break;
    case 'destroy':
      runDestroy(fixtureCase);
      break;
    default:
      throw new Error(
        `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)} — the dispatcher refuses unknown cases`,
      );
  }
}

const ownedRequirements = ['REQ-DOC-002', 'REQ-DOC-003', 'REQ-DOC-013', 'REQ-DOC-016'];

for (const requirementId of ownedRequirements) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as RecordsFixture;
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(
            (acceptedOps as readonly string[]).includes(fixtureCase.op),
            `${fixtureClass}: unknown op ${JSON.stringify(fixtureCase.op)}`,
          ).toBe(true);
        }
      }
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as RecordsFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}
