/**
 * On-call schedule domain unit tests (WP-023). Proves the pure decision surface:
 * resolve the on-call owner (overrides win; a provider outside the required
 * service scope is skipped — REQ-ADM-015), detect coverage gaps over a window
 * (REQ-ADM-041), select the effective rotation, and validate/publish a rotation
 * version (REQ-ADM-016 provisioning + audit).
 */
import { describe, expect, it } from 'vitest';

import {
  assertRotationValid,
  detectCoverageGaps,
  OnCallError,
  publishOnCallRotationVersion,
  resolveEffectiveRotation,
  resolveOnCall,
  type OnCallRotation,
  type OnCallSlot,
} from './oncall.js';

const rotationSlot = (over: Partial<OnCallSlot> = {}): OnCallSlot => ({
  slotId: 'slot-0001',
  rotationId: 'r-0001',
  kind: 'rotation',
  memberRef: 'synthetic-provider:reyes',
  serviceScopes: ['concierge-urgent', 'longevity'],
  windowStart: '2026-03-02T08:00:00Z',
  windowEnd: '2026-03-02T20:00:00Z',
  status: 'scheduled',
  ...over,
});

const rotation = (over: Partial<OnCallRotation> = {}): OnCallRotation => ({
  rotationId: 'oncall-concierge-nv',
  version: 1,
  effectiveOn: '2026-01-01',
  locationId: 'loc-nv-lasvegas',
  coverageMode: '24x7',
  serviceScopes: ['concierge-urgent', 'longevity'],
  memberOrder: [
    { memberRef: 'synthetic-provider:reyes', serviceScopes: ['concierge-urgent', 'longevity'] },
    { memberRef: 'synthetic-provider:okafor', serviceScopes: ['concierge-urgent'] },
  ],
  ...over,
});

describe('resolveOnCall', () => {
  it('returns the covering member at an instant inside the window', () => {
    const resolution = resolveOnCall([rotationSlot()], { atIso: '2026-03-02T12:00:00Z' });
    expect(resolution?.ownerRef).toBe('synthetic-provider:reyes');
    expect(resolution?.viaOverride).toBe(false);
  });

  it('an override slot wins over a rotation slot on the same window (REQ-ADM-041)', () => {
    const slots = [
      rotationSlot(),
      rotationSlot({
        slotId: 'slot-0002',
        kind: 'override',
        memberRef: 'synthetic-provider:okafor',
        serviceScopes: ['concierge-urgent'],
        status: 'overridden',
      }),
    ];
    const resolution = resolveOnCall(slots, { atIso: '2026-03-02T12:00:00Z' });
    expect(resolution?.ownerRef).toBe('synthetic-provider:okafor');
    expect(resolution?.viaOverride).toBe(true);
  });

  it('SKIPS a covering member outside the required service scope (REQ-ADM-015)', () => {
    // Okafor covers only concierge-urgent; Reyes covers longevity. For a longevity
    // case, Okafor is skipped and the qualified Reyes is chosen.
    const slots = [
      rotationSlot({
        memberRef: 'synthetic-provider:reyes',
        serviceScopes: ['concierge-urgent', 'longevity'],
      }),
      rotationSlot({
        slotId: 'slot-0002',
        kind: 'override',
        memberRef: 'synthetic-provider:okafor',
        serviceScopes: ['concierge-urgent'],
        status: 'overridden',
      }),
    ];
    const resolution = resolveOnCall(slots, {
      atIso: '2026-03-02T12:00:00Z',
      requiredServiceScope: 'longevity',
    });
    expect(resolution?.ownerRef).toBe('synthetic-provider:reyes');
  });

  it('returns null (a coverage gap) when no qualified slot covers the instant', () => {
    expect(
      resolveOnCall([rotationSlot({ serviceScopes: ['concierge-urgent'] })], {
        atIso: '2026-03-02T12:00:00Z',
        requiredServiceScope: 'longevity',
      }),
    ).toBeNull();
  });

  it('a vacated slot covers nobody', () => {
    expect(
      resolveOnCall([rotationSlot({ status: 'vacated' })], { atIso: '2026-03-02T12:00:00Z' }),
    ).toBeNull();
  });

  it('is exclusive at the window end (a slot [08,20) does not cover 20:00)', () => {
    expect(resolveOnCall([rotationSlot()], { atIso: '2026-03-02T20:00:00Z' })).toBeNull();
  });
});

describe('detectCoverageGaps', () => {
  it('reports no gaps when a slot covers the whole window', () => {
    const gaps = detectCoverageGaps([rotationSlot()], {
      fromIso: '2026-03-02T08:00:00Z',
      toIso: '2026-03-02T20:00:00Z',
    });
    expect(gaps).toEqual([]);
  });

  it('reports the uncovered tail as an unfilled-window gap', () => {
    const gaps = detectCoverageGaps([rotationSlot()], {
      fromIso: '2026-03-02T08:00:00Z',
      toIso: '2026-03-02T23:00:00Z',
    });
    expect(gaps).toEqual([
      {
        gapStart: '2026-03-02T20:00:00Z',
        gapEnd: '2026-03-02T23:00:00Z',
        reason: 'unfilled-window',
      },
    ]);
  });

  it('reports a vacated-only interval as a vacated-slot gap', () => {
    const gaps = detectCoverageGaps([rotationSlot({ status: 'vacated' })], {
      fromIso: '2026-03-02T09:00:00Z',
      toIso: '2026-03-02T11:00:00Z',
    });
    expect(gaps).toEqual([
      { gapStart: '2026-03-02T09:00:00Z', gapEnd: '2026-03-02T11:00:00Z', reason: 'vacated-slot' },
    ]);
  });

  it('reports an unqualified-only interval as no-qualified-oncall (REQ-ADM-015 gap)', () => {
    const gaps = detectCoverageGaps([rotationSlot({ serviceScopes: ['concierge-urgent'] })], {
      fromIso: '2026-03-02T09:00:00Z',
      toIso: '2026-03-02T11:00:00Z',
      requiredServiceScope: 'longevity',
    });
    expect(gaps).toEqual([
      {
        gapStart: '2026-03-02T09:00:00Z',
        gapEnd: '2026-03-02T11:00:00Z',
        reason: 'no-qualified-oncall',
      },
    ]);
  });

  it('coalesces adjacent same-reason gaps into one interval', () => {
    // Two back-to-back vacated slots leave one continuous vacated-slot gap.
    const slots = [
      rotationSlot({
        slotId: 's1',
        status: 'vacated',
        windowStart: '2026-03-02T09:00:00Z',
        windowEnd: '2026-03-02T10:00:00Z',
      }),
      rotationSlot({
        slotId: 's2',
        status: 'vacated',
        windowStart: '2026-03-02T10:00:00Z',
        windowEnd: '2026-03-02T11:00:00Z',
      }),
    ];
    const gaps = detectCoverageGaps(slots, {
      fromIso: '2026-03-02T09:00:00Z',
      toIso: '2026-03-02T11:00:00Z',
    });
    expect(gaps).toEqual([
      { gapStart: '2026-03-02T09:00:00Z', gapEnd: '2026-03-02T11:00:00Z', reason: 'vacated-slot' },
    ]);
  });

  it('throws when the window is not forward', () => {
    expect(() =>
      detectCoverageGaps([], { fromIso: '2026-03-02T11:00:00Z', toIso: '2026-03-02T09:00:00Z' }),
    ).toThrow(OnCallError);
  });
});

describe('resolveEffectiveRotation', () => {
  it('selects the highest version effective as-of the date for the location', () => {
    const rotations = [
      rotation({ version: 1, effectiveOn: '2026-01-01' }),
      rotation({ version: 2, effectiveOn: '2026-06-01' }),
    ];
    expect(resolveEffectiveRotation(rotations, 'loc-nv-lasvegas', '2026-03-01')?.version).toBe(1);
    expect(resolveEffectiveRotation(rotations, 'loc-nv-lasvegas', '2026-07-01')?.version).toBe(2);
  });

  it('narrows to the location — another location does not leak', () => {
    const rotations = [rotation({ locationId: 'loc-fl-miami' })];
    expect(resolveEffectiveRotation(rotations, 'loc-nv-lasvegas', '2026-07-01')).toBeUndefined();
  });
});

describe('assertRotationValid', () => {
  it('accepts a well-formed 24x7 rotation whose members cover every scope', () => {
    expect(() => assertRotationValid(rotation())).not.toThrow();
  });

  it('rejects a 24x7 rotation with a service scope no member covers', () => {
    expect(() =>
      assertRotationValid(
        rotation({
          serviceScopes: ['concierge-urgent', 'longevity', 'genetics'],
        }),
      ),
    ).toThrow(/no provisioned member covers service scope/);
  });

  it('rejects a rotation with no provisioned members', () => {
    expect(() => assertRotationValid(rotation({ memberOrder: [] }))).toThrow(OnCallError);
  });

  it('a business-mode rotation need not cover every scope 24/7', () => {
    expect(() =>
      assertRotationValid(
        rotation({
          coverageMode: 'business',
          serviceScopes: ['concierge-urgent', 'longevity', 'genetics'],
        }),
      ),
    ).not.toThrow();
  });
});

describe('publishOnCallRotationVersion', () => {
  it('validates and yields a config-change audit input with a grammar-clean config_ref', () => {
    const { auditInput } = publishOnCallRotationVersion({
      tenantId: 'northwind-synthetic',
      rotation: rotation({ version: 3 }),
      actorRef: 'synthetic-ops-admin',
      occurredAt: '2026-05-01T00:00:00Z',
    });
    expect(auditInput.stream).toBe('config-change');
    expect(auditInput.action).toBe('publish-oncall-rotation');
    expect(auditInput.detail.config_ref).toBe('oncall-rotation:oncall-concierge-nv:v3');
  });

  it('throws before producing anything if the rotation is malformed', () => {
    expect(() =>
      publishOnCallRotationVersion({
        tenantId: 'northwind-synthetic',
        rotation: rotation({ memberOrder: [] }),
        actorRef: 'synthetic-ops-admin',
        occurredAt: '2026-05-01T00:00:00Z',
      }),
    ).toThrow(OnCallError);
  });
});
