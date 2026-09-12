import { describe, expect, it } from 'vitest';
import type { RailSim } from '@practicehub/vendor-sim-kit';

import {
  checkRailAuthorityCoverage,
  type AuthorityRailCoverageRow,
} from './rail-authority-coverage.js';

const rail: RailSim = {
  railId: 'RAIL-002',
  authorityId: 'AUTH-002',
  name: 'synthetic-test',
  pinnedVendorVersion: 'v1',
  operations: ['legacy', 'clinical'],
  operationAuthorities: { legacy: 'AUTH-002', clinical: 'AUTH-007' },
  presets: [
    {
      presetId: 'legacy',
      authorityScenarioIndex: 0,
      primitiveIds: ['X-15'],
      summary: 'Synthetic conflict.',
    },
    {
      presetId: 'clinical',
      authorityScenarioIndex: 1,
      primitiveIds: ['X-15'],
      summary: 'Synthetic conflict.',
      operation: 'clinical',
      authorityId: 'AUTH-007',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 2, volumeTolerance: 0, emitsIdleHeartbeat: true },
  effectKeyFor: (operation, request) => `synthetic:${operation}/${request.idempotencyKey}`,
};
const join = new Map<string, AuthorityRailCoverageRow>([
  ['AUTH-002', { railIds: ['RAIL-002'], scenarioCount: 1 }],
  ['AUTH-007', { railIds: ['RAIL-001', 'RAIL-002'], scenarioCount: 2 }],
]);

describe('authority-rail coverage', () => {
  it('credits only executed declarations and keeps the other clinical ordinal absent', () => {
    const result = checkRailAuthorityCoverage([rail], join);
    expect(result.errors).toEqual([]);
    expect([...(result.coveredScenarios.get('AUTH-007') ?? [])]).toEqual([1]);
    const removed = checkRailAuthorityCoverage(
      [{ ...rail, presets: rail.presets.slice(0, 1) }],
      join,
    );
    expect(removed.errors).toEqual([]);
    expect(removed.coveredScenarios.has('AUTH-007')).toBe(false);
  });

  it('rejects known authorities joined to another rail even without a preset', () => {
    const badJoin = new Map(join).set('AUTH-007', { railIds: ['RAIL-001'], scenarioCount: 2 });
    const result = checkRailAuthorityCoverage(
      [{ ...rail, presets: rail.presets.slice(0, 1) }],
      badJoin,
    );
    expect(result.errors.join()).toContain('AUTH-007 does not name this rail');
    expect(checkRailAuthorityCoverage([rail], new Map()).errors.join()).toContain(
      'does not name this rail',
    );
  });

  it('rejects out-of-range ordinals without crediting them', () => {
    const bad = {
      ...rail,
      presets: rail.presets.map((preset) =>
        preset.authorityId === 'AUTH-007' ? { ...preset, authorityScenarioIndex: 2 } : preset,
      ),
    };
    const result = checkRailAuthorityCoverage([bad], join);
    expect(result.errors.join()).toContain('exceeds the 2 scenario(s) AUTH-007');
    expect(result.coveredScenarios.has('AUTH-007')).toBe(false);
  });

  it('rejects duplicate tuples across different valid rails', () => {
    const second = { ...rail, railId: 'RAIL-001' };
    const expanded = new Map(join).set('AUTH-002', {
      railIds: ['RAIL-001', 'RAIL-002'],
      scenarioCount: 1,
    });
    expect(checkRailAuthorityCoverage([rail, second], expanded).errors).toHaveLength(2);
  });

  it('allows the same ordinal under two different correctly joined authorities', () => {
    const sharedOrdinal = {
      ...rail,
      presets: rail.presets.map((preset) => ({ ...preset, authorityScenarioIndex: 0 })),
    };
    expect(checkRailAuthorityCoverage([sharedOrdinal], join).errors).toEqual([]);
  });

  it('refuses mismatched attribution instead of reporting fabricated coverage', () => {
    const bad = {
      ...rail,
      presets: rail.presets.map((preset) => ({
        ...preset,
        operation: 'legacy',
        authorityId: 'AUTH-007',
      })),
    };
    const result = checkRailAuthorityCoverage([bad], join);
    expect(result.errors.join()).toContain('operation/authority mismatch');
    expect(result.coveredScenarios.size).toBe(0);
  });
});
