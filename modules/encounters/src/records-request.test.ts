import { describe, expect, it } from 'vitest';

import type { RecordsClosurePolicy } from './records-clock.double.js';
import { RecordsRequestDesk, type RecordsRequestIntake } from './records-request.js';

const stricterState: RecordsClosurePolicy = {
  jurisdiction: 'NV',
  version: 2,
  durationDays: 10,
  escalationLeadDays: 3,
  synthetic: true,
};

function intake(
  requestId: string,
  jurisdictions: readonly string[] = ['FL'],
): RecordsRequestIntake {
  return {
    tenantId: 'northwind-synthetic',
    personId: 'person-1',
    requestId,
    receivedAt: '2026-06-01T00:00:00.000Z',
    jurisdictions,
  };
}

describe('RecordsRequestDesk', () => {
  it('opens a records-request WorkItem with a floor 30-day closure clock', () => {
    const desk = new RecordsRequestDesk([stricterState]);
    const item = desk.open(intake('rr-1'));
    expect(item.workItemClass).toBe('records-request');
    expect(item.obligationType).toBe('records-request-closure');
    expect(item.dueAt).toBe('2026-07-01T00:00:00.000Z');
    expect(item.escalateAt).toBe('2026-06-26T00:00:00.000Z');
    expect(item.policyProvenance).toEqual(['floor/v1']);
  });

  it('takes the strictest deadline when a state is shorter than the floor', () => {
    const desk = new RecordsRequestDesk([stricterState]);
    const item = desk.open(intake('rr-2', ['NV', 'FL']));
    expect(item.dueAt).toBe('2026-06-11T00:00:00.000Z');
    expect(item.escalateAt).toBe('2026-06-08T00:00:00.000Z');
    expect(item.policyProvenance).toEqual(['floor/v1', 'NV/v2']);
  });

  it('tracks the clock through pending, escalated and overdue, onto the worklist', () => {
    const desk = new RecordsRequestDesk([]);
    desk.open(intake('rr-1'));
    expect(desk.status('rr-1', '2026-06-10T00:00:00.000Z')).toBe('pending');
    expect(desk.worklist('2026-06-10T00:00:00.000Z')).toEqual([]);
    expect(desk.status('rr-1', '2026-06-26T00:00:00.000Z')).toBe('escalated');
    expect(desk.status('rr-1', '2026-07-01T00:00:00.000Z')).toBe('overdue');
    expect(desk.worklist('2026-07-02T00:00:00.000Z')).toEqual([
      { requestId: 'rr-1', status: 'overdue', dueAt: '2026-07-01T00:00:00.000Z' },
    ]);
  });

  it('closes only with evidence, and a closed clock leaves the worklist', () => {
    const desk = new RecordsRequestDesk([]);
    desk.open(intake('rr-1'));
    expect(() => desk.fulfil('rr-1', '', 'sha256:x', '2026-06-20T00:00:00.000Z')).toThrow(
      /evidence/,
    );
    const closed = desk.fulfil('rr-1', 'export-rr-1', 'sha256:abc', '2026-06-20T00:00:00.000Z');
    expect(closed.terminal).toBe('satisfied');
    expect(desk.status('rr-1', '2026-08-01T00:00:00.000Z')).toBe('satisfied');
    expect(desk.worklist('2026-08-01T00:00:00.000Z')).toEqual([]);
    expect(() => desk.withdraw('rr-1', 'late', '2026-06-21T00:00:00.000Z')).toThrow(
      /already satisfied/,
    );
  });

  it('withdrawal needs a reason and cancels the clock', () => {
    const desk = new RecordsRequestDesk([]);
    desk.open(intake('rr-1'));
    expect(() => desk.withdraw('rr-1', ' ', '2026-06-05T00:00:00.000Z')).toThrow(/reason/);
    desk.withdraw('rr-1', 'patient withdrew in writing', '2026-06-05T00:00:00.000Z');
    expect(desk.status('rr-1', '2026-07-05T00:00:00.000Z')).toBe('cancelled');
  });

  it('refuses a duplicate request id', () => {
    const desk = new RecordsRequestDesk([]);
    desk.open(intake('rr-1'));
    expect(() => desk.open(intake('rr-1'))).toThrow(/already open/);
  });
});
