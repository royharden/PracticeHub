/**
 * Executable 4-class fixture packs for the WP-023 requirement slice:
 *   REQ-ADM-015 — skip an on-call provider outside service scope;
 *   REQ-ADM-016 — provisioned 24/7 on-call escalation chain;
 *   REQ-ADM-041 — on-call schedule administration (rotations/overrides/gap alerting);
 *   REQ-TASK-003 — reassign owned threads before a planned absence breaches;
 *   REQ-TASK-020 — coverage/PTO planned handoff bulk-reassigns owned threads with context;
 *   REQ-TASK-034 — morning handoff artifact for overnight urgent threads;
 *   REQ-TASK-033 — abrupt-departure on-call vacate + owned-work bulk reassign (M05/M02 slice).
 * Every case runs against the REAL domain functions — a fixture that merely
 * "exists" without encoding its acceptance criterion cannot pass here.
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD (an unknown op
 * fails the pack's structural test, not silently), and the dispatcher ends in a
 * throwing default.
 */
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  assertRotationValid,
  detectCoverageGaps,
  publishOnCallRotationVersion,
  resolveEffectiveRotation,
  resolveOnCall,
  type OnCallRotation,
  type OnCallSlot,
} from './oncall.js';
import {
  buildMorningHandoff,
  planCoverageReassignment,
  planDepartureCoverage,
  type CoverageWindow,
  type DepartureVacate,
  type OvernightItem,
} from './coverage.js';
import type { ContextPackage } from './workitem.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

const acceptedOps = [
  'resolve-oncall',
  'detect-gaps',
  'rotation-effective',
  'rotation-valid',
  'plan-coverage',
  'morning-handoff',
  'departure',
  'publish-rotation',
] as const;
type FixtureOp = (typeof acceptedOps)[number];

const context: ContextPackage = {
  timerState: [],
  transcriptRef: 'synthetic-transcript:fx',
  priorOwnerNotesRef: 'synthetic-note:fx',
};

interface GapExpectation {
  readonly gapStart: string;
  readonly gapEnd: string;
  readonly reason: string;
}

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly slots?: readonly OnCallSlot[];
  readonly rotations?: readonly OnCallRotation[];
  readonly rotation?: OnCallRotation;
  readonly window?: CoverageWindow;
  readonly ownedItemIds?: readonly string[];
  readonly withContext?: boolean;
  readonly overnightItems?: readonly OvernightItem[];
  readonly vacatedSlots?: readonly DepartureVacate[];
  readonly atIso?: string;
  readonly fromIso?: string;
  readonly toIso?: string;
  readonly asOf?: string;
  readonly locationId?: string;
  readonly requiredServiceScope?: string;
  readonly handoffId?: string;
  readonly fromOwnerRef?: string | null;
  readonly toOwnerRef?: string;
  readonly departingOwnerRef?: string;
  readonly coveringOwnerRef?: string;
  readonly tenantId?: string;
  readonly actorRef?: string;
  readonly occurredAt?: string;
  readonly generatedAt?: string;
  readonly expectOwner?: string | null;
  readonly expectOverride?: boolean;
  readonly expectGaps?: readonly GapExpectation[];
  readonly expectGapCount?: number;
  readonly expectVersion?: number | null;
  readonly expectCount?: number;
  readonly expectToOwner?: string;
  readonly expectItemCount?: number;
  readonly expectReassignCount?: number;
  readonly expectVacatedCount?: number;
  readonly expectConfigRef?: string;
  readonly expectThrow?: boolean;
}

function ownedItems(
  ids: readonly string[],
  withContext: boolean,
): { workItemId: string; contextPackage: ContextPackage }[] {
  return ids.map((workItemId, index) => {
    if (!withContext && index === ids.length - 1) {
      return { workItemId } as unknown as { workItemId: string; contextPackage: ContextPackage };
    }
    return { workItemId, contextPackage: context };
  });
}

function runCase(fixtureCase: FixtureCase): void {
  switch (fixtureCase.op) {
    case 'resolve-oncall': {
      const resolution = resolveOnCall(fixtureCase.slots ?? [], {
        atIso: fixtureCase.atIso as string,
        ...(fixtureCase.requiredServiceScope === undefined
          ? {}
          : { requiredServiceScope: fixtureCase.requiredServiceScope }),
      });
      if (fixtureCase.expectOwner === null) {
        expect(resolution).toBeNull();
      } else if (fixtureCase.expectOwner !== undefined) {
        expect(resolution?.ownerRef).toBe(fixtureCase.expectOwner);
      }
      if (fixtureCase.expectOverride !== undefined) {
        expect(resolution?.viaOverride).toBe(fixtureCase.expectOverride);
      }
      break;
    }
    case 'detect-gaps': {
      const gaps = detectCoverageGaps(fixtureCase.slots ?? [], {
        fromIso: fixtureCase.fromIso as string,
        toIso: fixtureCase.toIso as string,
        ...(fixtureCase.requiredServiceScope === undefined
          ? {}
          : { requiredServiceScope: fixtureCase.requiredServiceScope }),
      });
      if (fixtureCase.expectGaps !== undefined) {
        expect(gaps).toEqual(fixtureCase.expectGaps);
      }
      if (fixtureCase.expectGapCount !== undefined) {
        expect(gaps.length).toBe(fixtureCase.expectGapCount);
      }
      break;
    }
    case 'rotation-effective': {
      const resolved = resolveEffectiveRotation(
        fixtureCase.rotations ?? [],
        fixtureCase.locationId as string,
        fixtureCase.asOf as string,
      );
      if (fixtureCase.expectVersion === null) {
        expect(resolved).toBeUndefined();
      } else if (fixtureCase.expectVersion !== undefined) {
        expect(resolved?.version).toBe(fixtureCase.expectVersion);
      }
      break;
    }
    case 'rotation-valid': {
      if (fixtureCase.expectThrow === true) {
        expect(() => assertRotationValid(fixtureCase.rotation as OnCallRotation)).toThrow();
      } else {
        expect(() => assertRotationValid(fixtureCase.rotation as OnCallRotation)).not.toThrow();
      }
      break;
    }
    case 'plan-coverage': {
      const build = (): ReturnType<typeof planCoverageReassignment> =>
        planCoverageReassignment({
          window: fixtureCase.window as CoverageWindow,
          ownedItems: ownedItems(fixtureCase.ownedItemIds ?? [], fixtureCase.withContext ?? true),
        });
      if (fixtureCase.expectThrow === true) {
        expect(build).toThrow();
        break;
      }
      const plan = build();
      if (fixtureCase.expectCount !== undefined) {
        expect(plan.length).toBe(fixtureCase.expectCount);
      }
      if (fixtureCase.expectToOwner !== undefined) {
        expect(plan.every((entry) => entry.toOwnerRef === fixtureCase.expectToOwner)).toBe(true);
        expect(plan.every((entry) => Array.isArray(entry.contextPackage.timerState))).toBe(true);
      }
      break;
    }
    case 'morning-handoff': {
      const build = (): ReturnType<typeof buildMorningHandoff> =>
        buildMorningHandoff({
          handoffId: fixtureCase.handoffId as string,
          fromOwnerRef: fixtureCase.fromOwnerRef ?? null,
          toOwnerRef: fixtureCase.toOwnerRef as string,
          overnightItems: fixtureCase.overnightItems ?? [],
          generatedAt: fixtureCase.generatedAt as string,
        });
      if (fixtureCase.expectThrow === true) {
        expect(build).toThrow();
        break;
      }
      const handoff = build();
      expect(handoff.kind).toBe('morning-handoff');
      if (fixtureCase.expectItemCount !== undefined) {
        expect(handoff.itemCount).toBe(fixtureCase.expectItemCount);
        expect(handoff.manifest.length).toBe(fixtureCase.expectItemCount);
      }
      break;
    }
    case 'departure': {
      const build = (): ReturnType<typeof planDepartureCoverage> =>
        planDepartureCoverage({
          handoffId: fixtureCase.handoffId as string,
          departingOwnerRef: fixtureCase.departingOwnerRef as string,
          coveringOwnerRef: fixtureCase.coveringOwnerRef as string,
          vacatedSlots: fixtureCase.vacatedSlots ?? [],
          ownedItems: ownedItems(fixtureCase.ownedItemIds ?? [], fixtureCase.withContext ?? true),
          generatedAt: fixtureCase.generatedAt as string,
        });
      if (fixtureCase.expectThrow === true) {
        expect(build).toThrow();
        break;
      }
      const plan = build();
      expect(plan.handoff.kind).toBe('departure');
      if (fixtureCase.expectReassignCount !== undefined) {
        expect(plan.reassignments.length).toBe(fixtureCase.expectReassignCount);
        expect(plan.handoff.itemCount).toBe(fixtureCase.expectReassignCount);
      }
      if (fixtureCase.expectVacatedCount !== undefined) {
        expect(plan.vacatedSlots.length).toBe(fixtureCase.expectVacatedCount);
      }
      break;
    }
    case 'publish-rotation': {
      const build = (): ReturnType<typeof publishOnCallRotationVersion> =>
        publishOnCallRotationVersion({
          tenantId: fixtureCase.tenantId ?? 'northwind-synthetic',
          rotation: fixtureCase.rotation as OnCallRotation,
          actorRef: fixtureCase.actorRef ?? 'synthetic-ops-admin',
          occurredAt: fixtureCase.occurredAt ?? '2026-05-01T00:00:00Z',
        });
      if (fixtureCase.expectThrow === true) {
        expect(build).toThrow();
        break;
      }
      const { auditInput } = build();
      expect(auditInput.stream).toBe('config-change');
      if (fixtureCase.expectConfigRef !== undefined) {
        expect(auditInput.detail.config_ref).toBe(fixtureCase.expectConfigRef);
      }
      break;
    }
    default: {
      throw new Error(
        `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)} — ` +
          'the dispatcher refuses unknown cases (review-009)',
      );
    }
  }
}

interface OnCallFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

for (const requirementId of [
  'REQ-ADM-015',
  'REQ-ADM-016',
  'REQ-ADM-041',
  'REQ-TASK-003',
  'REQ-TASK-020',
  'REQ-TASK-033',
  'REQ-TASK-034',
]) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as OnCallFixture;
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
        const fixture = pack.fixtures[fixtureClass] as unknown as OnCallFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}
