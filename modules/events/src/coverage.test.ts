/**
 * Coverage / PTO / handoff domain unit tests (WP-023). Proves the pure planners:
 * a coverage/PTO bulk reassignment fails closed on any missing context package
 * (REQ-TASK-020) and, for a planned window, runs ahead of the absence
 * (REQ-TASK-003); the morning-handoff artifact is exact (REQ-TASK-034); the
 * abrupt-departure plan vacates slots and bulk-reassigns owned work with context
 * (REQ-TASK-033, buildable slice).
 */
import { describe, expect, it } from 'vitest';

import {
  buildMorningHandoff,
  planCoverageReassignment,
  planDepartureCoverage,
  type CoverageWindow,
  type OwnedItemHandoff,
} from './coverage.js';
import { OnCallError } from './oncall.js';
import type { ContextPackage } from './workitem.js';

const context: ContextPackage = {
  timerState: [],
  transcriptRef: 'synthetic-transcript:fx',
  priorOwnerNotesRef: 'synthetic-note:fx',
};

const ptoWindow: CoverageWindow = {
  coverageId: 'cov-noor-0001',
  ownerRef: 'synthetic-guide:noor',
  fromAt: '2026-03-10T00:00:00Z',
  toAt: '2026-03-14T00:00:00Z',
  coverageTargetRef: 'synthetic-guide:maya',
  targetKind: 'owner',
  reason: 'pto',
  status: 'planned',
};

const items = (ids: readonly string[]): OwnedItemHandoff[] =>
  ids.map((workItemId) => ({ workItemId, contextPackage: context }));

describe('planCoverageReassignment', () => {
  it('builds one reassignment per owned item, each to the coverage owner with context (REQ-TASK-020)', () => {
    const plan = planCoverageReassignment({
      window: ptoWindow,
      ownedItems: items(['wi-thread-0011', 'wi-thread-0012']),
    });
    expect(plan.map((entry) => entry.workItemId)).toEqual(['wi-thread-0011', 'wi-thread-0012']);
    expect(plan.every((entry) => entry.toOwnerRef === 'synthetic-guide:maya')).toBe(true);
    expect(plan.every((entry) => entry.reason === 'pto')).toBe(true);
    expect(plan.every((entry) => entry.contextPackage === context)).toBe(true);
  });

  it('fails closed when an owned item carries no context package (never a silent orphan)', () => {
    expect(() =>
      planCoverageReassignment({
        window: ptoWindow,
        ownedItems: [{ workItemId: 'wi-thread-0011' } as OwnedItemHandoff],
      }),
    ).toThrow(/must carry a context package/);
  });

  it('refuses a pool target — pool release is not executable here (FWD-COVERAGE-030-POOL)', () => {
    expect(() =>
      planCoverageReassignment({
        window: {
          ...ptoWindow,
          targetKind: 'pool',
          coverageTargetRef: 'synthetic-pool:front-desk',
        },
        ownedItems: items(['wi-thread-0011']),
      }),
    ).toThrow(/pool/);
  });

  it('refuses a duplicate item and an empty plan', () => {
    expect(() =>
      planCoverageReassignment({ window: ptoWindow, ownedItems: items(['wi-a', 'wi-a']) }),
    ).toThrow(/twice/);
    expect(() => planCoverageReassignment({ window: ptoWindow, ownedItems: [] })).toThrow(
      /no owned items/,
    );
  });
});

describe('buildMorningHandoff', () => {
  it('summarizes overnight urgent threads as an exact manifest (REQ-TASK-034)', () => {
    const handoff = buildMorningHandoff({
      handoffId: 'handoff-morning-0001',
      fromOwnerRef: 'synthetic-provider:okafor',
      toOwnerRef: 'synthetic-guide:noor',
      overnightItems: [
        {
          workItemId: 'wi-overnight-0021',
          risk: 'urgent',
          contextPackageRef: 'synthetic-note:o-0021',
        },
        {
          workItemId: 'wi-overnight-0022',
          risk: 'elevated',
          contextPackageRef: 'synthetic-note:o-0022',
        },
      ],
      generatedAt: '2026-03-03T07:30:00Z',
    });
    expect(handoff.kind).toBe('morning-handoff');
    expect(handoff.itemCount).toBe(2);
    expect(handoff.manifest.map((entry) => entry.workItemId)).toEqual([
      'wi-overnight-0021',
      'wi-overnight-0022',
    ]);
  });

  it('a first-shift handoff may have no prior owner (fromOwnerRef null)', () => {
    const handoff = buildMorningHandoff({
      handoffId: 'handoff-morning-0002',
      fromOwnerRef: null,
      toOwnerRef: 'synthetic-guide:noor',
      overnightItems: [],
      generatedAt: '2026-03-03T07:30:00Z',
    });
    expect(handoff.fromOwnerRef).toBeNull();
    expect(handoff.itemCount).toBe(0);
  });

  it('refuses a duplicate item so the manifest is exact', () => {
    expect(() =>
      buildMorningHandoff({
        handoffId: 'handoff-morning-0003',
        fromOwnerRef: null,
        toOwnerRef: 'synthetic-guide:noor',
        overnightItems: [
          { workItemId: 'wi-x', risk: 'urgent', contextPackageRef: 'r1' },
          { workItemId: 'wi-x', risk: 'urgent', contextPackageRef: 'r2' },
        ],
        generatedAt: '2026-03-03T07:30:00Z',
      }),
    ).toThrow(/twice/);
  });
});

describe('planDepartureCoverage (REQ-TASK-033 M05/M02 slice)', () => {
  it('vacates on-call slots and bulk-reassigns owned work with context', () => {
    const plan = planDepartureCoverage({
      handoffId: 'dep-0001',
      departingOwnerRef: 'synthetic-provider:departed',
      coveringOwnerRef: 'synthetic-provider:reyes',
      vacatedSlots: [
        {
          slotId: 'slot-nv-0003',
          windowStart: '2026-03-03T00:00:00Z',
          windowEnd: '2026-03-03T08:00:00Z',
        },
      ],
      ownedItems: items(['wi-dep-0001', 'wi-dep-0002']),
      generatedAt: '2026-03-02T23:00:00Z',
    });
    expect(plan.vacatedSlots).toHaveLength(1);
    expect(plan.reassignments.map((entry) => entry.workItemId)).toEqual([
      'wi-dep-0001',
      'wi-dep-0002',
    ]);
    expect(
      plan.reassignments.every((entry) => entry.toOwnerRef === 'synthetic-provider:reyes'),
    ).toBe(true);
    expect(plan.handoff.kind).toBe('departure');
    expect(plan.handoff.itemCount).toBe(2);
  });

  it('fails closed if any departing item carries no context package', () => {
    expect(() =>
      planDepartureCoverage({
        handoffId: 'dep-0002',
        departingOwnerRef: 'synthetic-provider:departed',
        coveringOwnerRef: 'synthetic-provider:reyes',
        vacatedSlots: [],
        ownedItems: [{ workItemId: 'wi-dep-0003' } as OwnedItemHandoff],
        generatedAt: '2026-03-02T23:00:00Z',
      }),
    ).toThrow(OnCallError);
  });
});
