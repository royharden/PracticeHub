import { describe, expect, it } from 'vitest';

import {
  injectionOutcomeClasses,
  injectionPrimitiveCatalogStatus,
  injectionPrimitiveFamilies,
  injectionPrimitiveIdPattern,
  injectionPrimitivesV1,
  requireInjectionPrimitive,
  InjectionPrimitiveError,
} from './primitives.js';

describe('injection-primitive catalog (X-01..X-18)', () => {
  it('declares exactly eighteen primitives with unique, contiguous X-## ids', () => {
    expect(injectionPrimitivesV1).toHaveLength(18);
    const ids = injectionPrimitivesV1.map((primitive) => primitive.primitiveId);
    expect(new Set(ids).size).toBe(18);
    for (const id of ids) {
      expect(injectionPrimitiveIdPattern.test(id)).toBe(true);
    }
    expect(ids).toEqual(
      Array.from({ length: 18 }, (_, index) => `X-${String(index + 1).padStart(2, '0')}`),
    );
  });

  it('pins X-02/03/04/07 to crash / replay / duplicate / out-of-order, each naming its in-repo source', () => {
    const pinned = injectionPrimitivesV1.filter((primitive) => primitive.pinnedBy !== undefined);
    expect(pinned.map((primitive) => [primitive.primitiveId, primitive.name])).toEqual([
      ['X-02', 'process-crash'],
      ['X-03', 'replay'],
      ['X-04', 'duplicate'],
      ['X-07', 'out-of-order'],
    ]);
    for (const primitive of pinned) {
      expect(primitive.pinnedBy).toBe('docs/contracts/event-spine.md#forward-obligations');
    }
  });

  it('carries the accepted status and its ruling pointer (the catalog is data, not code)', () => {
    // ADR-ADJ-010 R-1: the derivation is BLESSED, so the graduation pointer is
    // discharged rather than carried. A regression to `draft` — or a stray
    // `pendingRef` — means the ruling was undone.
    expect(injectionPrimitiveCatalogStatus).toEqual({
      version: 'v1',
      status: 'accepted',
      ruledBy: 'ADR-ADJ-010',
    });
    expect(Object.keys(injectionPrimitiveCatalogStatus)).not.toContain('pendingRef');
  });

  it('draws every family and outcome class from the frozen vocabularies', () => {
    for (const primitive of injectionPrimitivesV1) {
      expect(injectionPrimitiveFamilies).toContain(primitive.family);
      expect(injectionOutcomeClasses).toContain(primitive.outcomeClass);
      expect(primitive.description.length).toBeGreaterThan(20);
    }
    // Every declared family is exercised by at least one primitive.
    const families = new Set(injectionPrimitivesV1.map((primitive) => primitive.family));
    expect([...families].sort()).toEqual([...injectionPrimitiveFamilies].sort());
  });

  it('fails closed on an id the catalog does not declare', () => {
    expect(() => requireInjectionPrimitive('X-99')).toThrow(InjectionPrimitiveError);
    expect(() => requireInjectionPrimitive('x-01')).toThrow(/unknown injection primitive/);
  });
});
