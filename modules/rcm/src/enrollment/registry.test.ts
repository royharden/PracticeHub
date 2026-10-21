import { describe, expect, it } from 'vitest';

import {
  ENROLLMENT_TRANSITIONS,
  EnrollmentRegistry,
  type EnrollmentState,
  type EvidenceAttachment,
  type EvidenceKind,
  type TransitionRequest,
} from './registry.js';

let evidenceSeq = 0;
function evidence(kind: EvidenceKind, capturedAt: string): EvidenceAttachment {
  evidenceSeq += 1;
  return { evidenceId: `ev-${evidenceSeq}`, kind, capturedAt, synthetic: true };
}

function step(
  to: EnrollmentState,
  at: string,
  kind: EvidenceKind,
  overrides: Partial<TransitionRequest> = {},
): TransitionRequest {
  return {
    payerId: 'payer-1',
    pathId: 'ch-sim-A',
    transaction: '837',
    to,
    at,
    actor: 'enroll-admin-1',
    reason: `move to ${to}`,
    evidence: [evidence(kind, at)],
    ...overrides,
  };
}

function enroll(registry: EnrollmentRegistry, overrides: Partial<TransitionRequest> = {}): void {
  registry.transition(step('requested', '2026-01-01T00:00:00Z', 'enrollment-request', overrides));
  registry.transition(
    step('pending-payer', '2026-01-02T00:00:00Z', 'payer-acknowledgment', overrides),
  );
  registry.transition(step('enrolled', '2026-01-10T00:00:00Z', 'payer-approval', overrides));
}

describe('WP-091 enrollment state machine (payer x path x transaction)', () => {
  it('walks the happy path with an evidence attachment on every transition', () => {
    const registry = new EnrollmentRegistry();
    enroll(registry);
    const record = registry.get({ payerId: 'payer-1', pathId: 'ch-sim-A', transaction: '837' });
    expect(record.state).toBe('enrolled');
    expect(record.since).toBe('2026-01-10T00:00:00Z');
    expect(record.evidenceDate).toBe('2026-01-10T00:00:00Z');
    expect(record.history.map((entry) => `${entry.from}>${entry.to}`)).toEqual([
      'not-enrolled>requested',
      'requested>pending-payer',
      'pending-payer>enrolled',
    ]);
    expect(record.history.every((entry) => entry.evidence.length > 0)).toBe(true);
    expect(
      registry.isEnrolled({ payerId: 'payer-1', pathId: 'ch-sim-A', transaction: '837' }),
    ).toBe(true);
  });

  it('refuses every transition the table does not allow, and allows every one it does', () => {
    const states = Object.keys(ENROLLMENT_TRANSITIONS) as EnrollmentState[];
    let allowed = 0;
    let refused = 0;
    for (const from of states) {
      for (const to of states) {
        const registry = new EnrollmentRegistry();
        // Drive a fresh key to `from` through a known path.
        const paths: Record<EnrollmentState, readonly EnrollmentState[]> = {
          'not-enrolled': [],
          requested: ['requested'],
          'pending-payer': ['requested', 'pending-payer'],
          enrolled: ['requested', 'pending-payer', 'enrolled'],
          rejected: ['requested', 'rejected'],
          suspended: ['requested', 'pending-payer', 'enrolled', 'suspended'],
          terminated: ['requested', 'pending-payer', 'enrolled', 'terminated'],
        };
        let day = 1;
        for (const target of paths[from]) {
          day += 1;
          const at = `2026-02-${String(day).padStart(2, '0')}T00:00:00Z`;
          registry.transition(
            step(target, at, target === 'enrolled' ? 'test-transaction' : 'note'),
          );
        }
        const at = '2026-03-01T00:00:00Z';
        const request = step(to, at, to === 'enrolled' ? 'payer-approval' : 'note');
        if (ENROLLMENT_TRANSITIONS[from].includes(to)) {
          expect(registry.transition(request).state).toBe(to);
          allowed += 1;
        } else {
          expect(() => registry.transition(request)).toThrow(/is not allowed/);
          refused += 1;
        }
      }
    }
    expect(allowed).toBe(11);
    expect(refused).toBe(38);
  });

  it('requires evidence, and refuses file-delivery alone as proof of enrolled', () => {
    const registry = new EnrollmentRegistry();
    expect(() =>
      registry.transition({ ...step('requested', '2026-01-01T00:00:00Z', 'note'), evidence: [] }),
    ).toThrow(/evidence attachment/);
    registry.transition(step('requested', '2026-01-01T00:00:00Z', 'enrollment-request'));
    registry.transition(step('pending-payer', '2026-01-02T00:00:00Z', 'payer-acknowledgment'));
    expect(() =>
      registry.transition(step('enrolled', '2026-01-03T00:00:00Z', 'file-delivery')),
    ).toThrow(/payer-approval or test-transaction/);
    expect(registry.get({ payerId: 'payer-1', pathId: 'ch-sim-A', transaction: '837' }).state).toBe(
      'pending-payer',
    );
  });

  it('refuses evidence captured after the transition, reused evidence ids and backdated transitions', () => {
    const registry = new EnrollmentRegistry();
    expect(() =>
      registry.transition({
        ...step('requested', '2026-01-01T00:00:00Z', 'note'),
        evidence: [evidence('note', '2026-01-02T00:00:00Z')],
      }),
    ).toThrow(/after the transition/);
    const first = evidence('enrollment-request', '2026-01-01T00:00:00Z');
    registry.transition({
      ...step('requested', '2026-01-01T00:00:00Z', 'note'),
      evidence: [first],
    });
    expect(() =>
      registry.transition({
        ...step('pending-payer', '2026-01-02T00:00:00Z', 'note'),
        evidence: [first],
      }),
    ).toThrow(/already attached/);
    expect(() =>
      registry.transition(step('pending-payer', '2025-12-31T00:00:00Z', 'payer-acknowledgment')),
    ).toThrow(/older than the current state/);
  });

  it('tracks each transaction and each path independently', () => {
    const registry = new EnrollmentRegistry();
    enroll(registry, { transaction: '837' });
    expect(
      registry.isEnrolled({ payerId: 'payer-1', pathId: 'ch-sim-A', transaction: '835' }),
    ).toBe(false);
    expect(
      registry.isEnrolled({ payerId: 'payer-1', pathId: 'ch-sim-B', transaction: '837' }),
    ).toBe(false);
    expect(
      registry.isEnrolled({ payerId: 'payer-2', pathId: 'ch-sim-A', transaction: '837' }),
    ).toBe(false);
  });

  it('refuses a transaction the path does not carry and leaves no record behind', () => {
    const registry = new EnrollmentRegistry();
    expect(() =>
      registry.transition(
        step('requested', '2026-01-01T00:00:00Z', 'enrollment-request', {
          pathId: 'payerportal-sim',
          transaction: '837',
        }),
      ),
    ).toThrow(/does not carry/);
    expect(() =>
      registry.transition(step('enrolled', '2026-01-01T00:00:00Z', 'payer-approval')),
    ).toThrow(/not-enrolled -> enrolled/);
    expect(registry.list()).toEqual([]);
  });

  it('requires an actor token and a reason on every transition', () => {
    const registry = new EnrollmentRegistry();
    expect(() =>
      registry.transition(step('requested', '2026-01-01T00:00:00Z', 'note', { reason: '' })),
    ).toThrow(/actor token and a reason/);
    expect(() =>
      registry.transition(
        step('requested', '2026-01-01T00:00:00Z', 'note', { actor: 'bad actor' }),
      ),
    ).toThrow(/actor token and a reason/);
  });
});
