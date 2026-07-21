/**
 * The WP-016 verification-gate properties.
 *
 * 1. "No stale permission survives": over exhaustively generated
 *    merge/unmerge event sequences, ANY cached identity-derived assertion
 *    (permission scope, outreach resolution, projection) written before an
 *    event touching its person is REFUSED afterward — for every person, at
 *    every point in the sequence.
 * 2. "Lineage restores": merge → unmerge round-trips EVERY artifact back to
 *    its original owner, over generated artifact sets — and the quarantine
 *    path never invents an owner.
 *
 * Deterministic generation (no Math.random): sequences and artifact sets are
 * enumerated from seeds so a failure names its exact case.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  executeMerge,
  executeUnmerge,
  invalidationEpochs,
  isCacheEntryStale,
  openMergeCase,
  readThroughCache,
  resolveMergedPerson,
  type CachedIdentityAssertion,
  type MergeArtifact,
  type MergeArtifactKind,
  type MergeEvent,
  mergeArtifactKinds,
} from './merge.js';

const tenant = 'northwind-synthetic' as TenantId;
const persons = ['np-p-alpha', 'np-p-beta', 'np-p-gamma', 'np-p-delta'] as PersonId[];

/** Deterministic pseudo-random walk from a seed (LCG; stable across runs). */
function* lcg(seed: number): Generator<number> {
  let state = seed >>> 0;
  for (;;) {
    state = (state * 1664525 + 1013904223) >>> 0;
    yield state;
  }
}

/**
 * Build a deterministic merge/unmerge sequence: each step either merges two
 * currently-distinct persons or unmerges a previously un-reversed merge.
 */
function buildEventSequence(seed: number, length: number): readonly MergeEvent[] {
  const random = lcg(seed);
  const next = (bound: number): number => (random.next().value as number) % bound;
  const events: MergeEvent[] = [];
  const openMerges: MergeEvent[] = [];
  for (let index = 0; index < length; index += 1) {
    const canUnmerge = openMerges.length > 0;
    const doUnmerge = canUnmerge && next(2) === 1;
    if (doUnmerge) {
      const merge = openMerges.splice(next(openMerges.length), 1)[0] as MergeEvent;
      events.push({
        eventId: `evt-${seed}-${index}`,
        tenantId: tenant,
        caseId: merge.caseId,
        kind: 'unmerge',
        survivorPersonId: merge.survivorPersonId,
        mergedPersonId: merge.mergedPersonId,
        basisAttributes: [],
        decidedBy: 'synthetic-compliance-001',
        rationale: 'synthetic reversal',
        reversesEventId: merge.eventId,
        synthetic: true,
      });
      continue;
    }
    const survivor = persons[next(persons.length)] as PersonId;
    let merged = persons[next(persons.length)] as PersonId;
    if (merged === survivor) {
      merged = persons[(persons.indexOf(survivor) + 1) % persons.length] as PersonId;
    }
    const event: MergeEvent = {
      eventId: `evt-${seed}-${index}`,
      tenantId: tenant,
      caseId: `case-${seed}-${index}`,
      kind: 'merge',
      survivorPersonId: survivor,
      mergedPersonId: merged,
      basisAttributes: ['given-name', 'family-name'],
      decidedBy: 'synthetic-data-migration-001',
      rationale: 'synthetic merge',
      evidenceRef: 'synthetic-evidence',
      synthetic: true,
    };
    events.push(event);
    openMerges.push(event);
  }
  return events;
}

describe('gate property: no stale permission survives', () => {
  it('an assertion cached before ANY event touching its person is refused afterward — every seed, every step, every person', () => {
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      const events = buildEventSequence(seed, 12);
      for (let cachePoint = 0; cachePoint <= events.length; cachePoint += 1) {
        const epochsAtWrite = invalidationEpochs(events.slice(0, cachePoint));
        for (const personId of persons) {
          const entry: CachedIdentityAssertion = {
            personId,
            epochAtWrite: epochsAtWrite.get(personId) ?? 0,
            payloadRef: `perm-${seed}-${cachePoint}-${personId}`,
          };
          for (let readPoint = cachePoint; readPoint <= events.length; readPoint += 1) {
            const epochsAtRead = invalidationEpochs(events.slice(0, readPoint));
            const touchedSinceWrite = events
              .slice(cachePoint, readPoint)
              .some(
                (event) => event.survivorPersonId === personId || event.mergedPersonId === personId,
              );
            const result = readThroughCache(epochsAtRead, entry);
            if (touchedSinceWrite) {
              expect(
                result,
                `seed ${seed}: entry for ${personId} cached at ${cachePoint} must be refused at ${readPoint}`,
              ).toEqual({ served: false, refused: 'stale-identity-cache' });
              expect(isCacheEntryStale(epochsAtRead, entry)).toBe(true);
            } else {
              expect(
                result,
                `seed ${seed}: untouched entry for ${personId} must still serve at ${readPoint}`,
              ).toEqual({ served: true, payloadRef: entry.payloadRef });
            }
          }
        }
      }
    }
  });

  it('an unmerge invalidates caches written while the pair was merged — the merged view is stale too', () => {
    const [merge] = buildEventSequence(99, 1) as [MergeEvent];
    const mergedEpochs = invalidationEpochs([merge]);
    const cachedWhileMerged: CachedIdentityAssertion = {
      personId: merge.survivorPersonId,
      epochAtWrite: mergedEpochs.get(merge.survivorPersonId) ?? 0,
      payloadRef: 'merged-view-projection',
    };
    expect(readThroughCache(mergedEpochs, cachedWhileMerged).served).toBe(true);
    const unmerge: MergeEvent = {
      ...merge,
      eventId: 'evt-99-unmerge',
      kind: 'unmerge',
      basisAttributes: [],
      reversesEventId: merge.eventId,
    };
    const reversedEpochs = invalidationEpochs([merge, unmerge]);
    expect(readThroughCache(reversedEpochs, cachedWhileMerged)).toEqual({
      served: false,
      refused: 'stale-identity-cache',
    });
  });
});

describe('gate property: lineage restores', () => {
  const kinds = mergeArtifactKinds;

  function buildArtifacts(seed: number, count: number, owner: PersonId): readonly MergeArtifact[] {
    const random = lcg(seed);
    return Array.from({ length: count }, (_, index) => ({
      kind: kinds[(random.next().value as number) % kinds.length] as MergeArtifactKind,
      artifactRef: `art-${seed}-${index}`,
      ownerPersonId: owner,
    }));
  }

  it('merge → unmerge returns EVERY artifact to its original owner, over generated artifact sets', () => {
    for (const seed of [7, 11, 19, 23]) {
      for (const count of [1, 3, 8]) {
        const survivor = persons[0] as PersonId;
        const merged = persons[1] as PersonId;
        const artifacts = buildArtifacts(seed, count, merged);
        const mergeCase = openMergeCase({
          caseId: `case-rt-${seed}-${count}`,
          tenantId: tenant,
          kind: 'possible-match',
          personIds: [survivor, merged],
          matchedAttributes: ['given-name', 'birth-date'],
          confidence: 'high',
          openedBy: 'synthetic-migration-workbench',
          source: 'synthetic-test',
        });
        const execution = executeMerge({
          mergeCase,
          basis: {
            comparedAttributes: ['given-name', 'birth-date'],
            decidedBy: 'synthetic-data-migration-001',
          },
          eventId: `evt-rt-${seed}-${count}`,
          survivorPersonId: survivor,
          mergedPersonId: merged,
          artifacts,
          mergedPersonSourceIdRefs: artifacts
            .filter((artifact) => artifact.kind === 'source-identifier')
            .map((artifact) => artifact.artifactRef),
          rationale: 'synthetic round-trip',
          evidenceRef: 'synthetic-evidence',
        });
        // Forward: every artifact re-attributed to the survivor, none dropped.
        expect(execution.lineage.map((record) => record.artifactRef).sort()).toEqual(
          artifacts.map((artifact) => artifact.artifactRef).sort(),
        );
        const outcome = executeUnmerge({
          mergeEvent: execution.event,
          lineage: execution.lineage,
          postMergeArtifacts: [],
          eventId: `evt-rt-${seed}-${count}-r`,
          approvedBy: 'synthetic-compliance-001',
          rationale: 'synthetic reversal',
        });
        if (outcome.outcome !== 'unmerged') {
          throw new Error(`round trip failed: ${outcome.outcome}`);
        }
        // Back: every artifact restored to its ORIGINAL owner — exact set match.
        const restored = new Map(
          outcome.restoredLineage.map((record) => [record.artifactRef, record.toPersonId]),
        );
        for (const artifact of artifacts) {
          expect(
            restored.get(artifact.artifactRef),
            `seed ${seed}/${count}: ${artifact.artifactRef} must restore to its origin`,
          ).toBe(artifact.ownerPersonId);
        }
        expect(outcome.report.indeterminateCount).toBe(0);
        // And the redirect is cancelled.
        expect(resolveMergedPerson([execution.event, outcome.event], merged).personId).toBe(merged);
      }
    }
  });

  it('the quarantine path never invents an owner — every indeterminate is reported, none re-attributed', () => {
    const survivor = persons[0] as PersonId;
    const merged = persons[1] as PersonId;
    const mergeCase = openMergeCase({
      caseId: 'case-q-1',
      tenantId: tenant,
      kind: 'possible-match',
      personIds: [survivor, merged],
      matchedAttributes: ['given-name', 'birth-date'],
      confidence: 'high',
      openedBy: 'synthetic-migration-workbench',
      source: 'synthetic-test',
    });
    const execution = executeMerge({
      mergeCase,
      basis: {
        comparedAttributes: ['given-name', 'birth-date'],
        decidedBy: 'synthetic-data-migration-001',
      },
      eventId: 'evt-q-1',
      survivorPersonId: survivor,
      mergedPersonId: merged,
      artifacts: buildArtifacts(3, 2, merged),
      mergedPersonSourceIdRefs: [],
      rationale: 'synthetic',
      evidenceRef: 'synthetic-evidence',
    });
    const ambiguous = [
      { kind: 'timeline-entry', artifactRef: 'post-both', referencesPersonIds: [survivor, merged] },
      { kind: 'timeline-entry', artifactRef: 'post-neither', referencesPersonIds: [] },
      {
        kind: 'timeline-entry',
        artifactRef: 'post-foreign',
        referencesPersonIds: [persons[2] as PersonId],
      },
    ];
    const outcome = executeUnmerge({
      mergeEvent: execution.event,
      lineage: execution.lineage,
      postMergeArtifacts: ambiguous,
      eventId: 'evt-q-1-r',
      approvedBy: 'synthetic-compliance-001',
      rationale: 'synthetic reversal',
    });
    if (outcome.outcome !== 'unmerged') {
      throw new Error(`quarantine case failed: ${outcome.outcome}`);
    }
    expect(outcome.quarantined.map((record) => record.artifactRef).sort()).toEqual(
      ambiguous.map((artifact) => artifact.artifactRef).sort(),
    );
    expect(
      outcome.report.rows
        .filter((row) => row.postUnmergeOwner === 'indeterminate')
        .map((row) => row.artifactRef)
        .sort(),
    ).toEqual(ambiguous.map((artifact) => artifact.artifactRef).sort());
  });
});
