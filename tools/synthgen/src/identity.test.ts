import { describe, expect, it } from 'vitest';

import { createSimulatedClock } from './clock.js';
import {
  generateIdentityWorld,
  overlapIsMergeSufficient,
  type IdentityWorldSpec,
} from './identity.js';

const clock = createSimulatedClock('2026-01-01T00:00:00Z');

const spec: IdentityWorldSpec = {
  tenantId: 'northwind-synthetic',
  masterSeed: 'test-seed',
  clock,
  householdCount: 24,
  personaAssignments: [
    { slug: 'prospective-patient', personaClass: 'patient/member', journeys: ['acquisition'] },
    { slug: 'data-migration-engineer', personaClass: 'staff', journeys: ['clinic-acquisition'] },
    { slug: 'concierge-guide', personaClass: 'staff', journeys: ['member-lifecycle'] },
  ],
  locations: [
    { locationId: 'northwind-nv-henderson', legalEntityId: 'northwind-health-nv', stateCode: 'NV' },
    {
      locationId: 'northwind-fl-coral-gables',
      legalEntityId: 'northwind-health-fl',
      stateCode: 'FL',
    },
  ],
};

describe('generateIdentityWorld', () => {
  it('regenerates byte-identically from the same spec', () => {
    expect(JSON.stringify(generateIdentityWorld(spec))).toBe(
      JSON.stringify(generateIdentityWorld(spec)),
    );
  });

  it('diverges when the master seed changes', () => {
    const other = generateIdentityWorld({ ...spec, masterSeed: 'other-seed' });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(generateIdentityWorld(spec)));
  });

  it('every subject and household carries the synthetic watermark', () => {
    const world = generateIdentityWorld(spec);
    for (const subject of world.subjects) {
      expect(subject.synthetic).toBe(true);
      for (const endpoint of subject.endpoints) {
        expect(endpoint.synthetic).toBe(true);
      }
    }
    for (const household of world.households) {
      expect(household.synthetic).toBe(true);
    }
  });

  it('gives multi-member households a SHARED phone and email — the standing WP-013 shape', () => {
    const world = generateIdentityWorld(spec);
    const multi = world.households.filter((house) => house.memberSubjectIds.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const household of multi) {
      const members = household.memberSubjectIds.map((id) => {
        const subject = world.subjects.find((entry) => entry.subjectId === id);
        if (!subject) {
          throw new Error(`household ${household.householdId} names unknown subject ${id}`);
        }
        return subject;
      });
      const phoneIds = new Set(
        members.flatMap((member) =>
          member.endpoints.filter((endpoint) => endpoint.kind === 'phone').map((e) => e.endpointId),
        ),
      );
      const emailIds = new Set(
        members.flatMap((member) =>
          member.endpoints.filter((endpoint) => endpoint.kind === 'email').map((e) => e.endpointId),
        ),
      );
      // One endpoint id across every member: the endpoint is a household fact,
      // not a person.
      expect(phoneIds.size).toBe(1);
      expect(emailIds.size).toBe(1);
      expect(household.sharedEndpointIds).toHaveLength(2);
    }
  });

  it('assigns every declared persona to at least one subject', () => {
    const world = generateIdentityWorld(spec);
    const covered = new Set(world.subjects.map((subject) => subject.personaSlug));
    for (const assignment of spec.personaAssignments) {
      expect(covered.has(assignment.slug)).toBe(true);
    }
  });

  it('produces out-of-state telehealth subjects (residence state <> location state)', () => {
    const world = generateIdentityWorld(spec);
    expect(world.subjects.some((subject) => subject.outOfStateTelehealth)).toBe(true);
  });

  it('refuses a spec that cannot build a world', () => {
    expect(() => generateIdentityWorld({ ...spec, householdCount: 0 })).toThrow(/positive/);
    expect(() => generateIdentityWorld({ ...spec, personaAssignments: [] })).toThrow(/persona/);
    expect(() => generateIdentityWorld({ ...spec, locations: [] })).toThrow(/location/);
  });
});

describe('known-truth collisions', () => {
  const world = generateIdentityWorld(spec);

  it('records an answer for every pair', () => {
    expect(world.collisions.length).toBeGreaterThan(0);
    for (const collision of world.collisions) {
      expect(['same-person', 'distinct-person']).toContain(collision.knownTruth);
      expect(collision.synthetic).toBe(true);
    }
  });

  it('a distinct-person pair overlaps ONLY on attributes that can never authorize a merge', () => {
    const distinct = world.collisions.filter((c) => c.knownTruth === 'distinct-person');
    expect(distinct.length).toBeGreaterThan(0);
    for (const collision of distinct) {
      expect(collision.mergeSufficientOverlap).toBe(false);
      expect(overlapIsMergeSufficient(collision.sharedAttributeNames)).toBe(false);
      // The trap in full: household endpoints and an address, nothing else.
      expect(collision.sharedAttributeNames).toEqual([
        'phoneEndpoint',
        'emailEndpoint',
        'postalAddress',
      ]);
      expect(collision.legacyTwin).toBeNull();
    }
  });

  it('a same-person pair carries a merge-sufficient overlap and a seedable twin', () => {
    const same = world.collisions.filter((c) => c.knownTruth === 'same-person');
    expect(same.length).toBeGreaterThan(0);
    for (const collision of same) {
      expect(collision.mergeSufficientOverlap).toBe(true);
      expect(overlapIsMergeSufficient(collision.sharedAttributeNames)).toBe(true);
      expect(collision.legacyTwin).not.toBeNull();
      expect(collision.legacyTwin?.personId).toBe(collision.rightSubjectId);
    }
  });

  it('the recorded flag is DERIVABLE from the overlap, never merely asserted', () => {
    for (const collision of world.collisions) {
      expect(overlapIsMergeSufficient(collision.sharedAttributeNames)).toBe(
        collision.mergeSufficientOverlap,
      );
    }
  });

  it('shares the identity model idea of sufficiency: contact facts are never enough', () => {
    expect(overlapIsMergeSufficient(['phoneEndpoint'])).toBe(false);
    expect(overlapIsMergeSufficient(['emailEndpoint'])).toBe(false);
    expect(overlapIsMergeSufficient(['postalAddress'])).toBe(false);
    expect(overlapIsMergeSufficient(['phoneEndpoint', 'emailEndpoint', 'postalAddress'])).toBe(
      false,
    );
    expect(overlapIsMergeSufficient(['birthDate'])).toBe(true);
    expect(overlapIsMergeSufficient(['legalName'])).toBe(true);
    expect(overlapIsMergeSufficient(['sourceIdentifier'])).toBe(true);
  });

  it('names every collision pair with distinct sides', () => {
    for (const collision of world.collisions) {
      expect(collision.leftSubjectId).not.toBe(collision.rightSubjectId);
    }
    const ids = world.collisions.map((collision) => collision.collisionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
