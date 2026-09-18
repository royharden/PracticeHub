import { describe, expect, it } from 'vitest';

import { ComponentMapError, ComponentMaps, type ComponentMap } from './component-map.js';

const map: ComponentMap = {
  tenantId: 'northwind-synthetic',
  mapVersionRef: 'map-v1',
  skuRef: 'sku:nwind-o1-aaaa',
  lines: [
    { componentRef: 'awv-core', kind: 'awv', quantity: 1, billed: true },
    { componentRef: 'ippe-core', kind: 'ippe', quantity: 1, billed: true },
    { componentRef: 'coach-note', kind: 'other', quantity: 1, billed: false },
  ],
};

describe('ComponentMap composition', () => {
  it('proves billed AWV/IPPE elements and rejects a missing billed element', () => {
    const maps = new ComponentMaps();
    maps.add(map);
    expect(
      maps.proveComposition({
        tenantId: map.tenantId,
        skuRef: map.skuRef,
        mapVersionRef: map.mapVersionRef,
        billedComponentRefs: ['awv-core', 'ippe-core'],
      }).lines,
    ).toHaveLength(3);
    expect(() =>
      maps.proveComposition({
        tenantId: map.tenantId,
        skuRef: map.skuRef,
        mapVersionRef: map.mapVersionRef,
        billedComponentRefs: ['awv-core'],
      }),
    ).toThrowError(new ComponentMapError('COMPOSITION_INCOMPLETE'));
  });

  it('rejects empty or duplicate component lines', () => {
    const maps = new ComponentMaps();
    expect(() => maps.add({ ...map, lines: [] })).toThrowError(
      new ComponentMapError('MAP_INVALID'),
    );
    const first = map.lines[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new ComponentMapError('MAP_INVALID');
    expect(() =>
      maps.add({
        ...map,
        lines: [first, { ...first, kind: 'ippe' }],
      }),
    ).toThrowError(new ComponentMapError('MAP_INVALID'));
  });
});
