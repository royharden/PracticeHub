/**
 * Worklist prioritization unit tests (WP-022, REQ-TASK-019): breached/escalated
 * first, then nearest-SLA, then non-SLA below ALL SLA items (E1), longest-waiting
 * tie-break (E2), empty-state (E3).
 */
import { describe, expect, it } from 'vitest';

import { prioritizeWorklist, toWorklistEntry, type WorklistEntry } from './worklist.js';
import { initialWorkItem, type WorkItem, type WorkItemOpen } from './workitem.js';
import type { SlaTimer } from './sla.js';

const now = '2026-03-02T10:00:00Z';

function slaItem(id: string, openedAt: string, extra: Partial<WorkItem> = {}): WorkItem {
  const open: WorkItemOpen = {
    workItemId: id,
    origin: 'thread',
    purpose: 'member-message',
    risk: 'routine',
    serviceTier: 'concierge',
    slaPolicyId: 'sla-concierge',
    policyVersion: 1,
    responseDueAt: openedAt,
    poolId: null,
    openedAt,
  };
  return { ...initialWorkItem(open), ...extra };
}

function nonSlaItem(id: string, openedAt: string): WorkItem {
  const open: WorkItemOpen = {
    workItemId: id,
    origin: 'admin',
    purpose: 'inventory-count',
    risk: 'routine',
    serviceTier: 'internal',
    slaPolicyId: null,
    policyVersion: null,
    responseDueAt: null,
    poolId: null,
    openedAt,
  };
  return initialWorkItem(open);
}

function timer(dueAt: string, state: SlaTimer['state'] = 'running'): SlaTimer {
  return {
    timerType: 'next_response',
    startedAt: '2026-03-02T08:00:00Z',
    dueAt,
    pausedTotalSeconds: 0,
    state,
  };
}

describe('prioritizeWorklist (REQ-TASK-019)', () => {
  it('empty worklist is an empty list, not an error (E3)', () => {
    expect(prioritizeWorklist([])).toEqual([]);
  });

  it('breached/escalated sort first, then nearest-SLA, then non-SLA (A1 + E1)', () => {
    const breached = toWorklistEntry(
      slaItem('wi-breached', '2026-03-02T08:00:00Z'),
      [timer('2026-03-02T09:00:00Z')],
      now,
    );
    const approaching = toWorklistEntry(
      slaItem('wi-soon', '2026-03-02T09:30:00Z'),
      [timer('2026-03-02T10:30:00Z')],
      now,
    );
    const later = toWorklistEntry(
      slaItem('wi-later', '2026-03-02T09:45:00Z'),
      [timer('2026-03-02T12:00:00Z')],
      now,
    );
    const admin = toWorklistEntry(nonSlaItem('wi-admin', '2026-01-01T00:00:00Z'), [], now);

    const sorted = prioritizeWorklist([admin, later, approaching, breached]);
    expect(sorted.map((entry) => entry.item.workItemId)).toEqual([
      'wi-breached',
      'wi-soon',
      'wi-later',
      'wi-admin',
    ]);
  });

  it('a non-SLA item sorts below every SLA item regardless of its own due date (E1)', () => {
    // The admin task is the oldest (waiting since January) but still sorts last.
    const sla = toWorklistEntry(
      slaItem('wi-sla', '2026-03-02T09:55:00Z'),
      [timer('2026-03-02T14:00:00Z')],
      now,
    );
    const admin = toWorklistEntry(nonSlaItem('wi-admin', '2026-01-01T00:00:00Z'), [], now);
    expect(prioritizeWorklist([admin, sla]).map((entry) => entry.item.workItemId)).toEqual([
      'wi-sla',
      'wi-admin',
    ]);
  });

  it('an escalated item outranks a merely-approaching one even if its timer is later', () => {
    const escalated = toWorklistEntry(
      slaItem('wi-esc', '2026-03-02T06:00:00Z', { escalated: true, priority: 'high' }),
      [timer('2026-03-02T18:00:00Z')],
      now,
    );
    const approaching = toWorklistEntry(
      slaItem('wi-soon', '2026-03-02T09:30:00Z'),
      [timer('2026-03-02T10:15:00Z')],
      now,
    );
    expect(
      prioritizeWorklist([approaching, escalated]).map((entry) => entry.item.workItemId),
    ).toEqual(['wi-esc', 'wi-soon']);
  });

  it('ties break by longest-waiting-first, never arbitrary order (E2)', () => {
    const a = toWorklistEntry(nonSlaItem('wi-b', '2026-02-02T00:00:00Z'), [], now);
    const b = toWorklistEntry(nonSlaItem('wi-a', '2026-01-01T00:00:00Z'), [], now);
    // Same rank + no SLA + different openedAt => the January item (longest waiting) wins.
    expect(prioritizeWorklist([a, b]).map((entry) => entry.item.workItemId)).toEqual([
      'wi-a',
      'wi-b',
    ]);
  });

  it('a resolved/met timer does not govern — the item drops out of the SLA ranking', () => {
    const entry: WorklistEntry = toWorklistEntry(
      slaItem('wi-met', '2026-03-02T08:00:00Z'),
      [timer('2026-03-02T09:00:00Z', 'met')],
      now,
    );
    expect(entry.governingTimer).toBeNull();
    expect(entry.slaState).toBe('none');
  });
});
