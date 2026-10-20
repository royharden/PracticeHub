import { describe, expect, it } from 'vitest';

import {
  authorizeOutbound,
  foldSendAuthority,
  holderAt,
  runDuplicateSendProbes,
  type SendAuthorityEvent,
} from './send-authority.js';
import { baseline, cutover, numberA, tenant } from './synthetic.js';

const clean = [baseline(numberA), cutover(numberA)];
const instants = [
  '2025-12-31T23:59:59Z',
  '2026-01-01T00:00:00Z',
  '2026-01-15T00:00:00Z',
  '2026-02-01T11:59:59Z',
  '2026-02-01T12:00:00Z',
  '2026-03-01T00:00:00Z',
];

/** Deterministic PRNG (mulberry32) so every injected ledger is reproducible by seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Injection = 'duplicate' | 'reorder' | 'late-duplicate' | 'drop' | 'conflict' | 'dual-capable';

function inject(seed: number): { events: SendAuthorityEvent[]; applied: Injection[] } {
  const random = prng(seed);
  let events = [...clean];
  const applied: Injection[] = [];
  const kinds: Injection[] = [
    'duplicate',
    'reorder',
    'late-duplicate',
    'drop',
    'conflict',
    'dual-capable',
  ];
  for (const kind of kinds) {
    if (random() >= 0.35) continue;
    applied.push(kind);
    const pick = events[Math.floor(random() * events.length)];
    if (pick === undefined) continue;
    switch (kind) {
      case 'duplicate':
        events.push({ ...pick });
        break;
      case 'reorder':
        events = [...events].reverse();
        break;
      case 'late-duplicate':
        events.unshift({ ...pick });
        break;
      case 'drop':
        events = events.filter((event) => event.eventId !== pick.eventId);
        break;
      case 'conflict':
        events.push({ ...pick, effectiveAt: '2026-01-20T00:00:00Z' });
        break;
      case 'dual-capable':
        events = events.map((event) =>
          event.eventId === pick.eventId
            ? { ...event, podium: 'send-capable', northwind: 'send-capable' }
            : event,
        );
        break;
    }
  }
  return { events, applied };
}

describe('WP-115 send authority (REQ-MIG-003, split-brain rule)', () => {
  it('folds a clean ledger into exclusive, time-bounded authority', () => {
    const proof = foldSendAuthority(tenant, numberA, clean);
    expect(proof.proven).toBe(true);
    expect(proof.holder).toBe('northwind');
    expect(holderAt(proof, '2026-01-15T00:00:00Z')).toBe('podium');
    expect(holderAt(proof, '2026-02-01T12:00:00Z')).toBe('northwind');
    expect(authorizeOutbound(proof, 'podium', '2026-03-01T00:00:00Z')).toEqual({
      allow: false,
      reason: 'not-send-holder:northwind',
      alternatePath: null,
    });
    expect(authorizeOutbound(proof, 'northwind', '2026-03-01T00:00:00Z').allow).toBe(true);
  });

  it('refuses a cutover that leaves Podium send-capable (Podium must be read-only before Northwind sends)', () => {
    const proof = foldSendAuthority(tenant, numberA, [
      baseline(numberA),
      { ...cutover(numberA), podium: 'send-capable' },
    ]);
    expect(proof.proven).toBe(false);
    expect(proof.reasons).toContain('send-capability-not-exclusive:2');
    for (const at of instants) {
      expect(authorizeOutbound(proof, 'northwind', at)).toMatchObject({
        allow: false,
        alternatePath: 'approved-alternate-path',
      });
      expect(authorizeOutbound(proof, 'podium', at).allow).toBe(false);
    }
  });

  it('requires every atomic transition field (routing, 10DLC, consent source, inbound route)', () => {
    const proof = foldSendAuthority(tenant, numberA, [
      baseline(numberA),
      { ...cutover(numberA), tenDlcCampaignRef: null },
    ]);
    expect(proof.reasons).toEqual(['incomplete-transition-record:2']);
    expect(proof.holder).toBe('none');
  });

  it('detects silent loss of a transition as a sequence gap and fails closed', () => {
    const third: SendAuthorityEvent = {
      ...cutover(numberA),
      eventId: `auth:${numberA}:3`,
      seq: 3,
      kind: 'freeze',
      fromHolder: 'northwind',
      toHolder: 'none',
      northwind: 'read-only',
      effectiveAt: '2026-02-10T00:00:00Z',
    };
    const proof = foldSendAuthority(tenant, numberA, [baseline(numberA), third]);
    expect(proof.proven).toBe(false);
    expect(proof.reasons).toContain('sequence-gap:before-3');
  });

  it('holds one-send-capable-system under 400 seeded injections of duplicate, reorder, late, drop, conflict and dual-capable faults', () => {
    const cleanProof = foldSendAuthority(tenant, numberA, clean);
    const seen = new Set<string>();
    let failedClosed = 0;
    let recovered = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const { events, applied } = inject(seed);
      applied.forEach((kind) => seen.add(kind));
      const proof = foldSendAuthority(tenant, numberA, events);
      const probes = runDuplicateSendProbes(proof, instants);
      expect(probes.holds, `seed ${seed} (${applied.join(',')})`).toBe(true);
      const destructive = applied.some((kind) =>
        ['drop', 'conflict', 'dual-capable'].includes(kind),
      );
      if (applied.includes('conflict') || applied.includes('dual-capable')) {
        // Both are applied after any drop, so the faulty record is always present.
        expect(proof.proven, `seed ${seed} proved despite ${applied.join(',')}`).toBe(false);
      }
      if (!destructive) {
        // Duplicates, late duplicates and reordering are absorbed exactly.
        expect(proof.proven, `seed ${seed} (${applied.join(',')})`).toBe(true);
        expect(proof.timeline).toEqual(cleanProof.timeline);
      }
      if (proof.proven) {
        recovered += 1;
        // A surviving proof is the clean authority or a prefix of it: losing the
        // cutover tail leaves the old rail authoritative (REQ-MIG-010), never both.
        expect(cleanProof.timeline.slice(0, proof.timeline.length), `seed ${seed}`).toEqual(
          proof.timeline,
        );
      } else {
        failedClosed += 1;
        for (const at of instants) {
          expect(authorizeOutbound(proof, 'podium', at).allow).toBe(false);
          expect(authorizeOutbound(proof, 'northwind', at).allow).toBe(false);
        }
      }
    }
    // The harness must actually have exercised every fault and both outcomes.
    expect([...seen].sort()).toEqual(
      ['conflict', 'drop', 'dual-capable', 'duplicate', 'late-duplicate', 'reorder'].sort(),
    );
    expect(failedClosed).toBeGreaterThan(0);
    expect(recovered).toBeGreaterThan(0);
  });

  it('rejects events from another tenant or number outright', () => {
    expect(() =>
      foldSendAuthority(tenant, numberA, [
        { ...baseline(numberA), tenantId: 'riverbend-synthetic' },
      ]),
    ).toThrow('crossed tenant or number scope');
  });

  it('treats an empty ledger as no authority, never as Podium by default', () => {
    const proof = foldSendAuthority(tenant, numberA, []);
    expect(proof.reasons).toEqual(['no-authority-record']);
    expect(authorizeOutbound(proof, 'podium', instants[2] ?? '').allow).toBe(false);
  });
});
