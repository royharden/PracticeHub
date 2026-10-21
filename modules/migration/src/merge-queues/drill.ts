import type {
  DownstreamSystemName,
  EngineClosureReport,
  EngineDownstreamExposure,
  EngineLineageRecord,
  EnginePostMergeArtifact,
  IdentityMergeEnginePort,
} from './engine-port.js';
import type { MergeLedger } from './bulk.js';
import { MergeQueueError } from './queue.js';

export interface UnmergeDrillInput {
  readonly engine: IdentityMergeEnginePort;
  readonly ledger: MergeLedger;
  readonly mergeEventId: string;
  readonly unmergeEventId: string;
  readonly approvedBy: string;
  readonly rationale: string;
  readonly postMergeArtifacts: readonly EnginePostMergeArtifact[];
  /** Downstream artifacts (claims, disclosures, referrals) touched while merged. */
  readonly exposures: readonly EngineDownstreamExposure[];
  /** Per-artifact confirmations reported back by each downstream owner. */
  readonly confirmations: ReadonlyMap<string, string>;
  readonly applyRestore?: (record: EngineLineageRecord) => void;
}

export interface UnmergeDrillReport {
  readonly mergeEventId: string;
  readonly outcome: 'unmerged' | 'blocked-no-lineage' | 'rolled-back-to-merged';
  readonly restoredCount: number;
  readonly quarantinedCount: number;
  readonly directivesBySystem: Readonly<Record<DownstreamSystemName, number>>;
  readonly claimActions: readonly { readonly artifactRef: string; readonly action: string }[];
  readonly wrongDisclosureIncidents: readonly string[];
  readonly providerEscalations: readonly string[];
  /** After a completed unmerge the merged-away id resolves to itself again. */
  readonly aliasRedirectCleared: boolean;
  readonly closure:
    EngineClosureReport | { readonly complete: false; readonly outstanding: readonly [] };
  readonly p0AlertArtifactRef?: string;
  readonly synthetic: true;
}

function emptySystems(): Record<DownstreamSystemName, number> {
  return { claims: 0, messages: 0, 'portal-results': 0, referrals: 0 };
}

/**
 * Lineage/unmerge drill over one recorded merge. A completed unmerge is
 * recorded in the ledger and propagated downstream: paid claims route to RCM
 * void/rebill, wrong-recipient disclosures open breach-evaluation incidents,
 * materialized clinical decisions escalate. A blocked or rolled-back unmerge
 * records nothing and propagates nothing: the merge stands, whole.
 */
export function runUnmergeDrill(input: UnmergeDrillInput): UnmergeDrillReport {
  const { engine, ledger } = input;
  const mergeEvent = ledger.event(input.mergeEventId);
  if (mergeEvent === undefined || mergeEvent.kind !== 'merge') {
    throw new MergeQueueError(`${input.mergeEventId} is not a recorded merge of this tenant`);
  }
  if (ledger.isReversed(mergeEvent.eventId)) {
    throw new MergeQueueError(`${mergeEvent.eventId} is already unmerged`);
  }
  const pair = new Set([mergeEvent.survivorPersonId, mergeEvent.mergedPersonId]);
  for (const exposure of input.exposures) {
    if (!pair.has(exposure.exposedPersonId) || !pair.has(exposure.correctPersonId)) {
      throw new MergeQueueError(`${exposure.artifactRef} does not involve the merged pair`);
    }
  }
  const outcome = engine.executeUnmerge({
    mergeEvent,
    lineage: ledger.lineage(),
    postMergeArtifacts: input.postMergeArtifacts,
    eventId: input.unmergeEventId,
    approvedBy: input.approvedBy,
    rationale: input.rationale,
    ...(input.applyRestore === undefined ? {} : { applyRestore: input.applyRestore }),
  });
  const base = {
    mergeEventId: mergeEvent.eventId,
    directivesBySystem: emptySystems(),
    claimActions: [],
    wrongDisclosureIncidents: [],
    providerEscalations: [],
    closure: { complete: false as const, outstanding: [] as const },
    synthetic: true as const,
  };
  if (outcome.outcome === 'blocked-no-lineage') {
    return {
      ...base,
      outcome: outcome.outcome,
      restoredCount: 0,
      quarantinedCount: 0,
      aliasRedirectCleared: false,
    };
  }
  if (outcome.outcome === 'rolled-back-to-merged') {
    return {
      ...base,
      outcome: outcome.outcome,
      restoredCount: 0,
      quarantinedCount: 0,
      aliasRedirectCleared: false,
      p0AlertArtifactRef: outcome.p0Alert.failedArtifactRef,
    };
  }
  ledger.append([outcome.event], [...outcome.restoredLineage, ...outcome.quarantined]);
  const propagation = engine.propagateUnmerge(input.exposures);
  const directivesBySystem = emptySystems();
  for (const directive of propagation.directives) {
    directivesBySystem[directive.system] += 1;
  }
  const resolved = engine.resolveMergedPerson(ledger.events(), mergeEvent.mergedPersonId);
  return {
    mergeEventId: mergeEvent.eventId,
    outcome: 'unmerged',
    restoredCount: outcome.restoredLineage.length,
    quarantinedCount: outcome.quarantined.length,
    directivesBySystem,
    claimActions: propagation.directives
      .filter((directive) => directive.system === 'claims')
      .map((directive) => ({ artifactRef: directive.artifactRef, action: directive.action })),
    wrongDisclosureIncidents: propagation.wrongDisclosureIncidents.map(
      (incident) => incident.artifactRef,
    ),
    providerEscalations: propagation.escalations.map((escalation) => escalation.artifactRef),
    aliasRedirectCleared: !resolved.redirected && resolved.personId === mergeEvent.mergedPersonId,
    closure: engine.unmergeClosureReport(propagation.directives, input.confirmations),
    synthetic: true,
  };
}
