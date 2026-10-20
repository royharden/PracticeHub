import { describe, expect, expectTypeOf, it } from 'vitest';

import * as root from './index.js';
import * as leaf0 from './ehi-ingest/index.js';
import * as leaf1 from './merge-queues/index.js';
import * as leaf2 from './podium-exit/index.js';

/** Regression: accepted leaf APIs must be usable from the module root; no replacement doubles. */
describe('migration public root integration', () => {
  it('retains an existing public entry point', () => {
    expect(root.foldMigrationBatch).toBeDefined();
  });

  it('exports the pinned runtime API with the original implementations', () => {
    expect(root.applyEhiDeltaOperation).toBe(leaf0.applyEhiDeltaOperation);
    expect(root.assertKind).toBe(leaf0.assertKind);
    expect(root.assertMappingSetScope).toBe(leaf0.assertMappingSetScope);
    expect(root.AthenaSimBulk).toBe(leaf0.AthenaSimBulk);
    expect(root.athenaSimBulkSourceRef).toBe(leaf0.athenaSimBulkSourceRef);
    expect(root.canonicalJson).toBe(leaf0.canonicalJson);
    expect(root.computeEhiDelta).toBe(leaf0.computeEhiDelta);
    expect(root.createEhiDeltaDrain).toBe(leaf0.createEhiDeltaDrain);
    expect(root.ehiDeltaDrainVersion).toBe(leaf0.ehiDeltaDrainVersion);
    expect(root.EhiIngestError).toBe(leaf0.EhiIngestError);
    expect(root.ehiResourceKinds).toBe(leaf0.ehiResourceKinds);
    expect(root.ehiResourceShapes).toBe(leaf0.ehiResourceShapes);
    expect(root.EhiStagingStore).toBe(leaf0.EhiStagingStore);
    expect(root.emptyKindCounts).toBe(leaf0.emptyKindCounts);
    expect(root.ingestEhiBulk).toBe(leaf0.ingestEhiBulk);
    expect(root.manifestForKind).toBe(leaf0.manifestForKind);
    expect(root.mapEhiRecord).toBe(leaf0.mapEhiRecord);
    expect(root.purgeEhiStaging).toBe(leaf0.purgeEhiStaging);
    expect(root.rehearseDriftToZero).toBe(leaf0.rehearseDriftToZero);
    expect(root.sha256).toBe(leaf0.sha256);
    expect(root.unknownAttributeLabel).toBe(leaf0.unknownAttributeLabel);
    expect(root.valueMatchesType).toBe(leaf0.valueMatchesType);
    expect(root.assertBulkMergePolicy).toBe(leaf1.assertBulkMergePolicy);
    expect(root.BULK_MERGE_MAX_BATCH).toBe(leaf1.BULK_MERGE_MAX_BATCH);
    expect(root.bulkMergeCapabilityGaps).toBe(leaf1.bulkMergeCapabilityGaps);
    expect(root.bulkMergeEventId).toBe(leaf1.bulkMergeEventId);
    expect(root.defaultBulkMergePolicy).toBe(leaf1.defaultBulkMergePolicy);
    expect(root.executeBulkMerge).toBe(leaf1.executeBulkMerge);
    expect(root.FrozenMergeEngineDouble).toBe(leaf1.FrozenMergeEngineDouble);
    expect(root.identityIdPattern).toBe(leaf1.identityIdPattern);
    expect(root.identityMatchAttributeNames).toBe(leaf1.identityMatchAttributeNames);
    expect(root.ImportMergeQueue).toBe(leaf1.ImportMergeQueue);
    expect(root.mergeArtifactKindsV1).toBe(leaf1.mergeArtifactKindsV1);
    expect(root.MergeEngineDoubleError).toBe(leaf1.MergeEngineDoubleError);
    expect(root.MergeLedger).toBe(leaf1.MergeLedger);
    expect(root.MergeQueueError).toBe(leaf1.MergeQueueError);
    expect(root.mergeQueueLanes).toBe(leaf1.mergeQueueLanes);
    expect(root.runUnmergeDrill).toBe(leaf1.runUnmergeDrill);
    expect(root.specializedReviewPatternNames).toBe(leaf1.specializedReviewPatternNames);
    expect(root.assessExportCompleteness).toBe(leaf2.assessExportCompleteness);
    expect(root.assessLoa).toBe(leaf2.assessLoa);
    expect(root.authorizeOutbound).toBe(leaf2.authorizeOutbound);
    expect(root.buildExportManifest).toBe(leaf2.buildExportManifest);
    expect(root.evaluateOptOutContinuity).toBe(leaf2.evaluateOptOutContinuity);
    expect(root.evaluatePodiumCancellation).toBe(leaf2.evaluatePodiumCancellation);
    expect(root.evaluatePortAcceptance).toBe(leaf2.evaluatePortAcceptance);
    expect(root.evaluatePortTransmission).toBe(leaf2.evaluatePortTransmission);
    expect(root.evaluateRecalendar).toBe(leaf2.evaluateRecalendar);
    expect(root.foldSendAuthority).toBe(leaf2.foldSendAuthority);
    expect(root.holderAt).toBe(leaf2.holderAt);
    expect(root.materializeSenderGrants).toBe(leaf2.materializeSenderGrants);
    expect(root.operationalConsentCapabilityId).toBe(leaf2.operationalConsentCapabilityId);
    expect(root.parseInstant).toBe(leaf2.parseInstant);
    expect(root.planCutover).toBe(leaf2.planCutover);
    expect(root.planHistoryImport).toBe(leaf2.planHistoryImport);
    expect(root.planPortRollback).toBe(leaf2.planPortRollback);
    expect(root.podiumObjectTypes).toBe(leaf2.podiumObjectTypes);
    expect(root.podiumPortCapabilityId).toBe(leaf2.podiumPortCapabilityId);
    expect(root.portAcceptanceChecks).toBe(leaf2.portAcceptanceChecks);
    expect(root.recalendarAcknowledgements).toBe(leaf2.recalendarAcknowledgements);
    expect(root.reconcileInbound).toBe(leaf2.reconcileInbound);
    expect(root.registerPortWaves).toBe(leaf2.registerPortWaves);
    expect(root.requireInstant).toBe(leaf2.requireInstant);
    expect(root.runDuplicateSendProbes).toBe(leaf2.runDuplicateSendProbes);
    expect(root.submitWavePortOrders).toBe(leaf2.submitWavePortOrders);
  });

  it('preserves representative public type contracts', () => {
    expectTypeOf<root.AthenaSimBulkOptions>().toEqualTypeOf<leaf0.AthenaSimBulkOptions>();
    expectTypeOf<root.BulkMergeItem>().toEqualTypeOf<leaf1.BulkMergeItem>();
    expectTypeOf<root.AuthorityInterval>().toEqualTypeOf<leaf2.AuthorityInterval>();
  });

  it('exposes strict porting instants through the root', () => {
    expect(root.parseInstant('2026-02-30T00:00:00Z')).toBeNull();
    expect(root.parseInstant('2026-02-28T00:00:00Z')).toBe(Date.parse('2026-02-28T00:00:00Z'));
  });
});
