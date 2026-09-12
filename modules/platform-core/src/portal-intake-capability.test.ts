import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  capabilityDefinitionsV1,
  capabilityRegistryV1,
  capabilitySeedBeginMarker,
  capabilitySeedEndMarker,
  renderCapabilitySeedSection,
  syntheticCapabilitySeedV1,
} from './capability-definitions.js';
import {
  applyCapabilityTransition,
  applyEventToGrants,
  foldCapabilityEvents,
  requireCapability,
} from './capability.js';

const grants = foldCapabilityEvents(
  capabilityRegistryV1,
  syntheticCapabilitySeedV1.initialGrants,
  syntheticCapabilitySeedV1.events,
);
const context = { tenantId: 'northwind-synthetic', scope: {} } as const;

describe('portal intake synthetic capability seed', () => {
  it('declares the approved owner and root scope exactly once', () => {
    expect(capabilityDefinitionsV1.filter((row) => row.capabilityId === 'portal.intake')).toEqual([
      expect.objectContaining({ ownerRole: 'portal-operations', dimensions: [] }),
    ]);
  });

  it('seeds adjacent Northwind steps through simulated and disabled Riverbend', () => {
    expect(
      grants
        .filter((row) => row.capabilityId === 'portal.intake')
        .map(({ tenantId, scope, state }) => ({ tenantId, scope, state }))
        .sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
    ).toEqual([
      { tenantId: 'northwind-synthetic', scope: {}, state: 'simulated' },
      { tenantId: 'riverbend-synthetic', scope: {}, state: 'disabled' },
    ]);
    expect(
      syntheticCapabilitySeedV1.events
        .filter((row) => row.capabilityId === 'portal.intake')
        .map(({ eventId, fromState, toState }) => ({ eventId, fromState, toState })),
    ).toEqual([
      { eventId: 'synthetic-cap-evt-0028', fromState: 'disabled', toState: 'scaffolded' },
      { eventId: 'synthetic-cap-evt-0029', fromState: 'scaffolded', toState: 'simulated' },
    ]);
    expect(new Set(syntheticCapabilitySeedV1.events.map((row) => row.eventId)).size).toBe(
      syntheticCapabilitySeedV1.events.length,
    );
  });

  it('allows simulated Northwind enqueue and denies Riverbend or pilot', () => {
    expect(
      requireCapability(capabilityRegistryV1, grants, context, 'portal.intake', {
        minimumState: 'simulated',
        checkpoint: 'enqueue',
      }).allowed,
    ).toBe(true);
    expect(() =>
      requireCapability(
        capabilityRegistryV1,
        grants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        'portal.intake',
        { minimumState: 'simulated', checkpoint: 'enqueue' },
      ),
    ).toThrow();
    expect(() =>
      requireCapability(capabilityRegistryV1, grants, context, 'portal.intake'),
    ).toThrow();
  });

  it('allows protective lowering and denies later enqueue', () => {
    const lowered = applyCapabilityTransition(
      capabilityRegistryV1,
      grants,
      {
        ...context,
        capabilityId: 'portal.intake',
        fromState: 'simulated',
        toState: 'scaffolded',
        initiatorRef: 'synthetic-portal-owner',
        approvals: [],
        evidenceRefs: [],
        reason: 'synthetic protective lowering',
      },
      'synthetic-portal-lowered',
    );
    expect(() =>
      requireCapability(
        capabilityRegistryV1,
        applyEventToGrants(grants, lowered),
        context,
        'portal.intake',
        { minimumState: 'simulated', checkpoint: 'enqueue' },
      ),
    ).toThrow();
  });

  it('keeps generated seed005 equal to the registry renderer', () => {
    const sql = readFileSync(
      new URL('../../../infra/postgres/seed/005-capability-seed.sql', import.meta.url),
      'utf8',
    );
    const begin = sql.indexOf(capabilitySeedBeginMarker);
    const end = sql.indexOf(capabilitySeedEndMarker);
    expect(sql.slice(begin, end + capabilitySeedEndMarker.length)).toBe(
      renderCapabilitySeedSection(capabilityRegistryV1, syntheticCapabilitySeedV1),
    );
  });
});
