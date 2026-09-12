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
const cashGrants = grants.filter((grant) => grant.capabilityId === 'cash.paid-service-loop');
const context = { tenantId: 'northwind-synthetic', scope: {} } as const;

describe('paid-service capability seed isolation', () => {
  it('declares the distinct root-scoped loop without changing membership authority', () => {
    expect(
      capabilityDefinitionsV1.filter(
        (definition) => definition.capabilityId === 'cash.paid-service-loop',
      ),
    ).toEqual([expect.objectContaining({ ownerRole: 'rcm-lead', dimensions: [] })]);
    expect(
      capabilityDefinitionsV1.find(
        (definition) => definition.capabilityId === 'membership.entitlement-ledger',
      ),
    ).toMatchObject({ ownerRole: 'sponsor', dimensions: [] });
    expect(() =>
      requireCapability(
        capabilityRegistryV1,
        cashGrants,
        context,
        'membership.entitlement-ledger',
        { minimumState: 'simulated' },
      ),
    ).toThrow();
  });

  it('seeds only the exact adjacent Northwind chain and disabled opposite tenant', () => {
    expect(
      cashGrants
        .map(({ tenantId, scope, state }) => ({ tenantId, scope, state }))
        .sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
    ).toEqual([
      { tenantId: 'northwind-synthetic', scope: {}, state: 'simulated' },
      { tenantId: 'riverbend-synthetic', scope: {}, state: 'disabled' },
    ]);
    const events = syntheticCapabilitySeedV1.events.filter(
      (event) => event.capabilityId === 'cash.paid-service-loop',
    );
    expect(
      events.map(({ tenantId, scope, fromState, toState }) => ({
        tenantId,
        scope,
        fromState,
        toState,
      })),
    ).toEqual([
      { tenantId: 'northwind-synthetic', scope: {}, fromState: 'disabled', toState: 'scaffolded' },
      { tenantId: 'northwind-synthetic', scope: {}, fromState: 'scaffolded', toState: 'simulated' },
    ]);
    expect(events.map((event) => event.eventId)).toEqual([
      'synthetic-cap-evt-0026',
      'synthetic-cap-evt-0027',
    ]);
    expect(new Set(syntheticCapabilitySeedV1.events.map((event) => event.eventId)).size).toBe(
      syntheticCapabilitySeedV1.events.length,
    );
    expect(
      cashGrants.find((grant) => grant.tenantId === 'riverbend-synthetic')?.sinceEventId,
    ).toBeNull();
  });

  it.each(['enqueue', 'drain'] as const)(
    'permits synthetic commands at %s but refuses the other tenant',
    (checkpoint) => {
      expect(
        requireCapability(capabilityRegistryV1, grants, context, 'cash.paid-service-loop', {
          minimumState: 'simulated',
          checkpoint,
        }).allowed,
      ).toBe(true);
      expect(() =>
        requireCapability(
          capabilityRegistryV1,
          grants,
          { tenantId: 'riverbend-synthetic', scope: {} },
          'cash.paid-service-loop',
          { minimumState: 'simulated', checkpoint },
        ),
      ).toThrow();
    },
  );

  it('does not seed the default pilot floor or any higher authority', () => {
    expect(() =>
      requireCapability(capabilityRegistryV1, grants, context, 'cash.paid-service-loop'),
    ).toThrow();
  });

  it('allows protective lowering without approval/evidence and blocks subsequent commands', () => {
    const loweredEvent = applyCapabilityTransition(
      capabilityRegistryV1,
      grants,
      {
        ...context,
        capabilityId: 'cash.paid-service-loop',
        fromState: 'simulated',
        toState: 'scaffolded',
        initiatorRef: 'synthetic-rcm-owner',
        approvals: [],
        evidenceRefs: [],
        reason: 'synthetic protective lowering',
      },
      'synthetic-paid-service-lowered',
    );
    expect(() =>
      requireCapability(
        capabilityRegistryV1,
        applyEventToGrants(grants, loweredEvent),
        context,
        'cash.paid-service-loop',
        { minimumState: 'simulated', checkpoint: 'drain' },
      ),
    ).toThrow();
  });

  it('keeps generated005 exactly equal to the registry renderer', () => {
    const sql = readFileSync(
      new URL('../../../infra/postgres/seed/005-capability-seed.sql', import.meta.url),
      'utf8',
    );
    const begin = sql.indexOf(capabilitySeedBeginMarker);
    const end = sql.indexOf(capabilitySeedEndMarker);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    expect(sql.slice(begin, end + capabilitySeedEndMarker.length)).toBe(
      renderCapabilitySeedSection(capabilityRegistryV1, syntheticCapabilitySeedV1),
    );
  });
});
