/**
 * Worklist prioritization (WP-022, REQ-TASK-019). Contract:
 * docs/contracts/workitem-sla-api.md (FROZEN).
 *
 * Pure sort over folded work items + their governing SLA timer. The ordering is
 * the acceptance criterion, encoded as a total order so patient-facing SLA risk
 * always wins visual priority:
 *   1. breached / escalated first (A1);
 *   2. then SLA-bearing items by nearest time-to-breach (A1, ascending);
 *   3. then non-SLA items by due date (A1) — but ALWAYS below every SLA-bearing
 *      item regardless of its own due date (E1);
 *   tie-break: longest-waiting first, never arbitrary order (E2);
 *   an empty worklist is an empty list, not an error (E3).
 */

import { computeTimerState, type SlaTimer } from './sla.js';
import type { WorkItem } from './workitem.js';

export type WorklistSlaState = 'breached' | 'escalated' | 'approaching' | 'none';

export interface WorklistEntry {
  readonly item: WorkItem;
  /** The active timer that governs urgency (soonest-due running/breached), or null. */
  readonly governingTimer: SlaTimer | null;
  readonly slaState: WorklistSlaState;
  /** Seconds until breach (negative if already breached); null for non-SLA items. */
  readonly timeToBreachSeconds: number | null;
}

const RANK_BREACHED_ESCALATED = 0;
const RANK_SLA_BEARING = 1;
const RANK_NON_SLA = 2;

function instant(iso: string): number {
  return Date.parse(iso);
}

/**
 * Pick the timer that governs an item's urgency: among its non-terminal timers
 * (running or breached), the one with the soonest effective breach point. A met
 * timer never governs. Returns null when the item has no live timer.
 */
export function governingTimer(timers: readonly SlaTimer[], nowIso: string): SlaTimer | null {
  const live = timers
    .map((timer) => ({ timer, state: computeTimerState(timer, nowIso) }))
    .filter((entry) => entry.state === 'running' || entry.state === 'breached');
  if (live.length === 0) {
    return null;
  }
  return (
    live
      .map((entry) => entry.timer)
      .sort(
        (left, right) =>
          instant(left.dueAt) +
          left.pausedTotalSeconds * 1000 -
          (instant(right.dueAt) + right.pausedTotalSeconds * 1000),
      )[0] ?? null
  );
}

/** Build a worklist entry for one item from its folded timers, as-of now. */
export function toWorklistEntry(
  item: WorkItem,
  timers: readonly SlaTimer[],
  nowIso: string,
): WorklistEntry {
  const governing = governingTimer(timers, nowIso);
  if (!item.hasSla || governing === null) {
    return {
      item,
      governingTimer: governing,
      slaState: item.escalated ? 'escalated' : 'none',
      timeToBreachSeconds: null,
    };
  }
  const state = computeTimerState(governing, nowIso);
  const breachPoint = instant(governing.dueAt) + governing.pausedTotalSeconds * 1000;
  const timeToBreachSeconds = (breachPoint - instant(nowIso)) / 1000;
  const slaState: WorklistSlaState = item.escalated
    ? 'escalated'
    : state === 'breached'
      ? 'breached'
      : 'approaching';
  return { item, governingTimer: governing, slaState, timeToBreachSeconds };
}

function primaryRank(entry: WorklistEntry): number {
  if (entry.slaState === 'breached' || entry.slaState === 'escalated') {
    return RANK_BREACHED_ESCALATED;
  }
  return entry.item.hasSla ? RANK_SLA_BEARING : RANK_NON_SLA;
}

/**
 * The total order. Compares by primary rank, then by urgency within the rank
 * (time-to-breach for SLA ranks; due date for non-SLA), then breaks every tie by
 * longest-waiting-first (earliest openedAt), then by id for full determinism.
 */
export function compareWorklistEntries(left: WorklistEntry, right: WorklistEntry): number {
  const rankDelta = primaryRank(left) - primaryRank(right);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  const leftUrgency = left.timeToBreachSeconds;
  const rightUrgency = right.timeToBreachSeconds;
  if (leftUrgency !== null && rightUrgency !== null && leftUrgency !== rightUrgency) {
    return leftUrgency - rightUrgency;
  }
  if (leftUrgency === null && rightUrgency === null) {
    // Non-SLA (and breached-with-equal-urgency) items order by due date.
    const leftDue = left.item.responseDueAt ?? left.item.openedAt;
    const rightDue = right.item.responseDueAt ?? right.item.openedAt;
    if (leftDue !== rightDue) {
      return instant(leftDue) - instant(rightDue);
    }
  }
  // Longest-waiting-first tie-break (E2), never arbitrary order.
  if (left.item.openedAt !== right.item.openedAt) {
    return instant(left.item.openedAt) - instant(right.item.openedAt);
  }
  return left.item.workItemId.localeCompare(right.item.workItemId);
}

/**
 * Prioritize a Guide's worklist. Pure and stable — a re-sort on any SLA-state
 * change is just a re-run (A2: the worklist reflects the change without a manual
 * refresh). An empty input yields an empty worklist (E3).
 */
export function prioritizeWorklist(entries: readonly WorklistEntry[]): readonly WorklistEntry[] {
  return [...entries].sort(compareWorklistEntries);
}
