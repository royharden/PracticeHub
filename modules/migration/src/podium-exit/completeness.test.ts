import { describe, expect, it } from 'vitest';

import {
  assessExportCompleteness,
  buildExportManifest,
  planHistoryImport,
  podiumObjectTypes,
  type PodiumHistoryRecord,
  type PodiumObjectType,
  type SampleTrace,
} from './completeness.js';
import { numberA, tenant } from './synthetic.js';

const record = (
  objectType: PodiumObjectType,
  recordRef: string,
  extra: Partial<PodiumHistoryRecord> = {},
): PodiumHistoryRecord => ({
  objectType,
  recordRef,
  locationRef: 'loc-nv-henderson',
  occurredAt: '2026-01-02T10:00:00Z',
  deleted: false,
  attachmentRefs: [],
  ...extra,
});

const records: readonly PodiumHistoryRecord[] = [
  ...podiumObjectTypes.map((objectType) => record(objectType, `${objectType}-1`)),
  record('messages', 'messages-2', {
    numberRef: numberA,
    contactRef: 'contact-syn-001',
    attachmentRefs: ['media-1'],
    occurredAt: '2026-01-03T10:00:00Z',
  }),
  record('messages', 'messages-3', { deleted: true, occurredAt: '2026-01-04T10:00:00Z' }),
];

const allImported: Partial<Record<PodiumObjectType, readonly string[]>> = Object.fromEntries(
  podiumObjectTypes.map((objectType) => [
    objectType,
    records.filter((item) => item.objectType === objectType).map((item) => item.recordRef),
  ]),
);

const sample: SampleTrace = {
  sampleRef: 'ui-sample-1',
  objectType: 'messages',
  fields: {
    message: 'complete',
    'delivery-state': 'complete',
    ownership: 'complete',
    'consent-evidence': 'complete',
    'review-attribution': 'not-applicable',
    'call-artifact': 'not-applicable',
  },
  reasonCode: null,
};

const full = buildExportManifest({
  tenantId: tenant,
  exportRef: 'podium-export-synthetic-1',
  source: 'contracted-full-export',
  records,
  omissions: [],
});

describe('WP-115 Podium export completeness (REQ-MIG-002)', () => {
  it('hashes a manifest covering every contracted object type with counts, ranges, media and deletions', () => {
    expect(full.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    const messages = full.objects.find((entry) => entry.objectType === 'messages');
    expect(messages).toMatchObject({
      count: 3,
      earliest: '2026-01-02T10:00:00Z',
      latest: '2026-01-04T10:00:00Z',
      attachmentCount: 1,
      deletionCount: 1,
    });
    expect(full.objects.map((entry) => entry.objectType)).toEqual([...podiumObjectTypes]);
  });

  it('is ready to terminate only when every object reconciles and samples trace', () => {
    const result = assessExportCompleteness({
      manifest: full,
      sourceRecords: records,
      importedRecordRefs: allImported,
      samples: [sample],
      ownerRef: 'vendor-mgmt-owner',
    });
    expect(result).toMatchObject({
      readiness: 'ready-to-terminate',
      podiumMode: 'terminable',
      blockers: [],
    });
    expect(result.controlTotals).toHaveLength(podiumObjectTypes.length);
    expect(result.controlTotals.every((total) => total.state === 'reconciled')).toBe(true);
  });

  it('never accepts a contact CSV as the archive; Podium stays searchable read-only', () => {
    const csv = buildExportManifest({
      tenantId: tenant,
      exportRef: 'podium-contacts-csv',
      source: 'contact-csv',
      records,
      omissions: [],
    });
    const result = assessExportCompleteness({
      manifest: csv,
      sourceRecords: records,
      importedRecordRefs: allImported,
      samples: [sample],
      ownerRef: 'vendor-mgmt-owner',
    });
    expect(result).toMatchObject({
      readiness: 'blocked',
      podiumMode: 'searchable-read-only',
      blockers: ['export-source-not-full-archive:contact-csv'],
      blockingOwnerRef: 'vendor-mgmt-owner',
    });
  });

  it('blocks on an unexplained missing message and accepts it once reason-coded', () => {
    const imported = { ...allImported, messages: ['messages-1', 'messages-2'] };
    const unexplained = assessExportCompleteness({
      manifest: full,
      sourceRecords: records,
      importedRecordRefs: imported,
      samples: [sample],
      ownerRef: 'vendor-mgmt-owner',
    });
    expect(unexplained.blockers).toEqual(['count-unreconciled:podium-messages']);

    const coded = buildExportManifest({
      tenantId: tenant,
      exportRef: 'podium-export-synthetic-1',
      source: 'contracted-full-export',
      records,
      omissions: [
        { objectType: 'messages', recordRef: 'messages-3', reasonCode: 'deleted-at-source' },
      ],
    });
    const explained = assessExportCompleteness({
      manifest: coded,
      sourceRecords: records,
      importedRecordRefs: imported,
      samples: [sample],
      ownerRef: 'vendor-mgmt-owner',
    });
    expect(explained.readiness).toBe('ready-to-terminate');
    expect(explained.controlTotals.find((total) => total.name === 'podium-messages')).toMatchObject(
      {
        state: 'explained-difference',
        explanationRef: 'podium-omission:messages:1',
      },
    );
  });

  it('detects a tampered manifest, a drifted source, an incomplete sample and a missing owner', () => {
    const tampered = { ...full, objects: full.objects.slice(1) };
    const result = assessExportCompleteness({
      manifest: tampered,
      sourceRecords: records.slice(1),
      importedRecordRefs: allImported,
      samples: [{ ...sample, fields: { ...sample.fields, 'consent-evidence': 'missing' } }],
      ownerRef: null,
    });
    expect(result.readiness).toBe('blocked');
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'manifest-hash-mismatch',
        'object-type-missing:contacts',
        'sample-trace-incomplete:ui-sample-1',
        'blocking-owner-missing',
      ]),
    );
  });

  it('blocks when no UI sample was traced at all', () => {
    const result = assessExportCompleteness({
      manifest: full,
      sourceRecords: records,
      importedRecordRefs: allImported,
      samples: [],
      ownerRef: 'vendor-mgmt-owner',
    });
    expect(result.blockers).toEqual(['no-sampled-ui-traces']);
  });
});

describe('WP-115 history import plan', () => {
  it('groups thread-bound history per number and contact and reason-codes the rest', () => {
    const plan = planHistoryImport(records);
    expect(plan.threads).toEqual([
      { numberRef: numberA, contactRef: 'contact-syn-001', recordRefs: ['messages-2'] },
    ]);
    expect(plan.omissions).toEqual([
      { objectType: 'calls', recordRef: 'calls-1', reasonCode: 'unmatched-thread-party' },
      {
        objectType: 'conversations',
        recordRef: 'conversations-1',
        reasonCode: 'unmatched-thread-party',
      },
      { objectType: 'messages', recordRef: 'messages-1', reasonCode: 'unmatched-thread-party' },
      { objectType: 'messages', recordRef: 'messages-3', reasonCode: 'deleted-at-source' },
    ]);
    expect(plan.standaloneRecordRefs).toEqual([
      'assignments-1',
      'audit-1',
      'consent-1',
      'contacts-1',
      'notes-1',
      'reviews-1',
    ]);
  });
});
