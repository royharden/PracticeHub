import { describe, expect, it } from 'vitest';

import { normalizeRailAuthorityBindings } from './authority-binding.js';
import { VendorSimEngine } from './engine.js';
import type { RailSim } from './rail.js';

const legacyPreset = {
  presetId: 'legacy',
  authorityScenarioIndex: 0,
  primitiveIds: ['X-15'],
  summary: 'Synthetic version conflict.',
};
const legacy: RailSim = {
  railId: 'RAIL-002',
  authorityId: 'AUTH-002',
  name: 'test-rail',
  pinnedVendorVersion: 'v1',
  operations: ['read'],
  presets: [legacyPreset],
  heartbeat: { expectedEffectsPerWindow: 2, volumeTolerance: 0, emitsIdleHeartbeat: true },
  effectKeyFor: (operation, request) => `synthetic:${operation}/${request.idempotencyKey}`,
};
const shared: RailSim = {
  ...legacy,
  operations: ['read', 'clinical'],
  operationAuthorities: { read: 'AUTH-002', clinical: 'AUTH-007' },
  presets: [
    legacyPreset,
    { ...legacyPreset, presetId: 'clinical', operation: 'clinical', authorityId: 'AUTH-007' },
  ],
};

describe('scalar authority per operation', () => {
  it('keeps legacy meaning and allows equal ordinals for different authorities', () => {
    expect([...normalizeRailAuthorityBindings(legacy).operations]).toEqual([['read', 'AUTH-002']]);
    expect(normalizeRailAuthorityBindings(legacy).presets[0]).toMatchObject({
      operation: 'read',
      authorityId: 'AUTH-002',
    });
    expect(
      normalizeRailAuthorityBindings(shared).presets.map(({ operation, authorityId }) => [
        operation,
        authorityId,
      ]),
    ).toEqual([
      ['read', 'AUTH-002'],
      ['clinical', 'AUTH-007'],
    ]);
  });

  const badDeclarations: [string, unknown][] = [
    ['missing operation', { operationAuthorities: { read: 'AUTH-002' } }],
    [
      'extra operation',
      { operationAuthorities: { read: 'AUTH-002', clinical: 'AUTH-007', extra: 'AUTH-007' } },
    ],
    [
      'non-scalar authority',
      { operationAuthorities: { read: ['AUTH-002'], clinical: 'AUTH-007' } },
    ],
    ['invalid authority', { operationAuthorities: { read: 'bad', clinical: 'AUTH-007' } }],
    ['null map', { operationAuthorities: null }],
    ['array map', { operationAuthorities: [] }],
    ['duplicate operation', { operations: ['read', 'read'] }],
    ['no legacy owner', { operationAuthorities: { read: 'AUTH-007', clinical: 'AUTH-007' } }],
    ['partial preset', { presets: [{ ...legacyPreset, operation: 'read' }] }],
    ['authority-only preset', { presets: [{ ...legacyPreset, authorityId: 'AUTH-002' }] }],
    [
      'mismatched preset',
      { presets: [{ ...legacyPreset, operation: 'clinical', authorityId: 'AUTH-002' }] },
    ],
    [
      'legacy first operation remapped',
      { operations: ['clinical', 'read'], presets: [legacyPreset] },
    ],
    ['duplicate preset ID', { presets: [legacyPreset, legacyPreset] }],
    ['duplicate tuple', { presets: [legacyPreset, { ...legacyPreset, presetId: 'other' }] }],
    ['negative ordinal', { presets: [{ ...legacyPreset, authorityScenarioIndex: -1 }] }],
    ['fractional ordinal', { presets: [{ ...legacyPreset, authorityScenarioIndex: 0.5 }] }],
  ];
  it.each(badDeclarations)('refuses %s at engine construction', (_name, override) => {
    const rail = { ...shared, ...(override as object) } as RailSim;
    expect(() => new VendorSimEngine({ rails: [rail] })).toThrow();
  });
});
