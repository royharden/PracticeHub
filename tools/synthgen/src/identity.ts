/**
 * Identity and household synthesis (WP-029; synthetic-data-plan §3.1).
 *
 * Two things this file exists to produce that a clinical generator cannot:
 *
 * 1. HOUSEHOLDS with SHARED CONTACT ENDPOINTS. WP-013 proved structurally that
 *    an endpoint is never a person and that endpoint equality can never
 *    authorize a merge. That proof needs a world where sharing actually
 *    happens, so the corpus builds households whose members share a phone and
 *    an email on purpose.
 *
 * 2. NEAR-DUPLICATE IDENTITIES WITH KNOWN TRUTH. Every collision pair carries a
 *    recorded answer — `same-person` or `distinct-person` — decided at
 *    GENERATION time, not inferred later. That is what makes the corpus usable
 *    as a scoring set: a matcher can be graded against truth instead of against
 *    its own opinion. The `distinct-person` pairs are the trap: they overlap
 *    only on household endpoints, which is precisely the overlap the merge
 *    guard must refuse.
 */
import { birthDateForAge, type SimulatedClock } from './clock.js';
import { createSeededRng, deriveDomainSeed, type SeededRng } from './rng.js';
import {
  affirmedNamePool,
  familyNamePool,
  givenNamePool,
  legacySourceSystems,
  stateGeographyV1,
} from './vocab.js';

export interface CorpusName {
  readonly givenName: string;
  readonly familyName: string;
}

export interface CorpusEndpoint {
  readonly endpointId: string;
  readonly kind: 'phone' | 'email';
  readonly value: string;
  readonly relationship: 'self' | 'household';
  readonly verification: 'asserted' | 'verified';
  readonly synthetic: true;
}

export interface CorpusSourceIdentifier {
  readonly sourceSystem: string;
  readonly sourceValue: string;
  readonly verification: 'asserted' | 'verified';
  readonly synthetic: true;
}

export interface CorpusSubject {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly householdId: string;
  readonly personaSlug: string;
  readonly personaClass: string;
  readonly journeys: readonly string[];
  readonly legalName: CorpusName;
  readonly affirmedName: CorpusName | null;
  readonly birthDate: string;
  readonly residenceState: string;
  readonly city: string;
  readonly homeLocationId: string;
  readonly legalEntityId: string;
  /** Residence state differs from the state of the location that sees them. */
  readonly outOfStateTelehealth: boolean;
  readonly status: 'provisional' | 'verified';
  readonly endpoints: readonly CorpusEndpoint[];
  readonly sourceIdentifiers: readonly CorpusSourceIdentifier[];
  readonly synthetic: true;
}

export interface CorpusHousehold {
  readonly householdId: string;
  readonly tenantId: string;
  readonly residenceState: string;
  readonly city: string;
  readonly streetRef: string;
  readonly memberSubjectIds: readonly string[];
  readonly sharedEndpointIds: readonly string[];
  readonly synthetic: true;
}

export type CollisionTruth = 'same-person' | 'distinct-person';

export interface IdentityCollision {
  readonly collisionId: string;
  readonly leftSubjectId: string;
  readonly rightSubjectId: string;
  /** Decided at generation time. This is the answer, not a hypothesis. */
  readonly knownTruth: CollisionTruth;
  /** Attribute NAMES the pair overlaps on — never the values. */
  readonly sharedAttributeNames: readonly string[];
  /**
   * True only when the overlap contains at least one attribute the merge guard
   * treats as merge-sufficient. `distinct-person` pairs are constructed so this
   * is always false: they collide on household endpoints alone.
   */
  readonly mergeSufficientOverlap: boolean;
  /**
   * For a `same-person` pair, the acquired-clinic twin record: a REAL second
   * person carrying the same legal name and birth date under a second legacy
   * crosswalk value, with no patient record of its own. It is seeded as a row,
   * not merely described, because a merge queue that has nothing to merge
   * proves nothing. Null for `distinct-person` pairs.
   */
  readonly legacyTwin: {
    readonly personId: string;
    readonly sourceSystem: string;
    readonly sourceValue: string;
    readonly synthetic: true;
  } | null;
  readonly synthetic: true;
}

export interface IdentityWorldSpec {
  readonly tenantId: string;
  readonly masterSeed: string;
  readonly clock: SimulatedClock;
  readonly householdCount: number;
  readonly personaAssignments: readonly {
    readonly slug: string;
    readonly personaClass: string;
    readonly journeys: readonly string[];
  }[];
  readonly locations: readonly {
    readonly locationId: string;
    readonly legalEntityId: string;
    readonly stateCode: string;
  }[];
}

export interface IdentityWorld {
  readonly households: readonly CorpusHousehold[];
  readonly subjects: readonly CorpusSubject[];
  readonly collisions: readonly IdentityCollision[];
}

/**
 * Attributes the identity model treats as capable of contributing to a merge
 * basis. Mirrors WP-013's rule that phone, email and postal address are
 * structurally never sufficient — the corpus labels its collisions with the
 * SAME notion of sufficiency the guard uses, so a `mergeSufficientOverlap:
 * false` pair is a genuine negative rather than a differently-worded one.
 */
const mergeSufficientAttributeNames: ReadonlySet<string> = new Set([
  'legalName',
  'birthDate',
  'sourceIdentifier',
]);

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function phoneValue(index: number): string {
  // E.164, 555 exchange, sequential line number: never a routable number and
  // never shaped like a government identifier.
  return `+1702555${pad(1000 + index, 4)}`;
}

function emailValue(household: number): string {
  return `household-${pad(household, 4)}@synthetic.invalid`;
}

function nameFor(rng: SeededRng): CorpusName {
  return { givenName: rng.pick(givenNamePool), familyName: rng.pick(familyNamePool) };
}

/**
 * Build the identity world. Deterministic in every part: household count and
 * persona assignments come from the spec, everything else from seeds derived
 * off the master seed.
 */
export function generateIdentityWorld(spec: IdentityWorldSpec): IdentityWorld {
  if (spec.householdCount <= 0) {
    throw new Error('generateIdentityWorld: householdCount must be positive');
  }
  if (spec.personaAssignments.length === 0) {
    throw new Error('generateIdentityWorld: at least one persona assignment is required');
  }
  if (spec.locations.length === 0) {
    throw new Error('generateIdentityWorld: at least one location is required');
  }

  const householdRng = createSeededRng(deriveDomainSeed(spec.masterSeed, 'households'));
  const personRng = createSeededRng(deriveDomainSeed(spec.masterSeed, 'persons'));
  const collisionRng = createSeededRng(deriveDomainSeed(spec.masterSeed, 'collisions'));

  const households: CorpusHousehold[] = [];
  const subjects: CorpusSubject[] = [];
  let personaCursor = 0;
  let subjectCounter = 0;

  for (let index = 0; index < spec.householdCount; index += 1) {
    const householdId = `sg-hh-${pad(index + 1, 4)}`;
    const geography = householdRng.pick(stateGeographyV1);
    const city = householdRng.pick(geography.cities);
    const street = householdRng.pick(geography.streets);
    // Household size 1..3: singles, couples, and a guardian+minor shape.
    const memberCount = 1 + householdRng.nextInt(3);

    const sharedPhoneId = `sg-ep-ph-${pad(index + 1, 4)}`;
    const sharedEmailId = `sg-ep-em-${pad(index + 1, 4)}`;
    const memberIds: string[] = [];

    for (let member = 0; member < memberCount; member += 1) {
      subjectCounter += 1;
      const subjectId = `sg-p-${pad(subjectCounter, 4)}`;
      const persona = spec.personaAssignments[personaCursor % spec.personaAssignments.length];
      personaCursor += 1;
      if (!persona) {
        throw new Error('generateIdentityWorld: persona assignment cursor fell off the list');
      }
      const location = spec.locations[personRng.nextInt(spec.locations.length)];
      if (!location) {
        throw new Error('generateIdentityWorld: location draw fell off the list');
      }
      const legalName = nameFor(personRng);
      const affirmed = personRng.chance(1, 6)
        ? { givenName: personRng.pick(affirmedNamePool), familyName: legalName.familyName }
        : null;
      const age = member === 0 ? 24 + personRng.nextInt(50) : 2 + personRng.nextInt(70);

      const endpoints: CorpusEndpoint[] = [
        {
          endpointId: sharedPhoneId,
          kind: 'phone',
          value: phoneValue(index + 1),
          relationship: memberCount > 1 ? 'household' : 'self',
          verification: 'asserted',
          synthetic: true,
        },
        {
          endpointId: sharedEmailId,
          kind: 'email',
          value: emailValue(index + 1),
          relationship: memberCount > 1 ? 'household' : 'self',
          verification: 'asserted',
          synthetic: true,
        },
      ];

      const sourceIdentifiers: CorpusSourceIdentifier[] = personRng.chance(1, 3)
        ? [
            {
              sourceSystem: personRng.pick(legacySourceSystems),
              sourceValue: `lg-${pad(subjectCounter, 6)}`,
              verification: 'asserted',
              synthetic: true,
            },
          ]
        : [];

      subjects.push({
        subjectId,
        tenantId: spec.tenantId,
        householdId,
        personaSlug: persona.slug,
        personaClass: persona.personaClass,
        journeys: persona.journeys,
        legalName,
        affirmedName: affirmed,
        birthDate: birthDateForAge(spec.clock, age, personRng.nextInt(365)),
        residenceState: geography.stateCode,
        city,
        homeLocationId: location.locationId,
        legalEntityId: location.legalEntityId,
        outOfStateTelehealth: geography.stateCode !== location.stateCode,
        status: personRng.chance(3, 4) ? 'verified' : 'provisional',
        endpoints,
        sourceIdentifiers,
        synthetic: true,
      });
      memberIds.push(subjectId);
    }

    households.push({
      householdId,
      tenantId: spec.tenantId,
      residenceState: geography.stateCode,
      city,
      streetRef: `${pad(100 + index, 4)} ${street}`,
      memberSubjectIds: memberIds,
      sharedEndpointIds: memberCount > 1 ? [sharedPhoneId, sharedEmailId] : [],
      synthetic: true,
    });
  }

  return {
    households,
    subjects,
    collisions: buildCollisions(subjects, households, collisionRng),
  };
}

/**
 * Collision construction. Two shapes, both with the answer recorded:
 *
 * - `distinct-person`: two members of ONE household. They overlap on the shared
 *   phone and email and on nothing else. `mergeSufficientOverlap` is false, and
 *   a matcher that merges them is wrong in a way the corpus can prove.
 * - `same-person`: one subject re-imported from a legacy system under a second
 *   record. The overlap includes legal name, birth date, and a legacy source
 *   identifier, so `mergeSufficientOverlap` is true.
 */
function buildCollisions(
  subjects: readonly CorpusSubject[],
  households: readonly CorpusHousehold[],
  rng: SeededRng,
): IdentityCollision[] {
  const collisions: IdentityCollision[] = [];
  let counter = 0;

  for (const household of households) {
    if (household.memberSubjectIds.length < 2) {
      continue;
    }
    const [left, right] = household.memberSubjectIds;
    if (left === undefined || right === undefined) {
      continue;
    }
    counter += 1;
    collisions.push({
      collisionId: `sg-col-${pad(counter, 4)}`,
      leftSubjectId: left,
      rightSubjectId: right,
      knownTruth: 'distinct-person',
      sharedAttributeNames: ['phoneEndpoint', 'emailEndpoint', 'postalAddress'],
      mergeSufficientOverlap: false,
      legacyTwin: null,
      synthetic: true,
    });
  }

  // Same-person pairs come from subjects that carry a legacy identifier: the
  // acquired-clinic re-import case. One in three of them is selected, so the
  // set is a deterministic subset rather than every eligible subject.
  const eligible = subjects.filter((subject) => subject.sourceIdentifiers.length > 0);
  for (const subject of eligible) {
    if (!rng.chance(1, 3)) {
      continue;
    }
    counter += 1;
    const origin = subject.sourceIdentifiers[0];
    if (!origin) {
      continue;
    }
    const twinId = `${subject.subjectId}-legacy`;
    collisions.push({
      collisionId: `sg-col-${pad(counter, 4)}`,
      leftSubjectId: subject.subjectId,
      rightSubjectId: twinId,
      knownTruth: 'same-person',
      sharedAttributeNames: ['legalName', 'birthDate', 'sourceIdentifier'],
      mergeSufficientOverlap: true,
      legacyTwin: {
        personId: twinId,
        sourceSystem: origin.sourceSystem,
        sourceValue: `${origin.sourceValue}-b`,
        synthetic: true,
      },
      synthetic: true,
    });
  }

  return collisions;
}

/**
 * Recompute a collision's `mergeSufficientOverlap` from its overlap alone. The
 * corpus gate asserts the recorded flag equals this, so a hand-edited corpus
 * cannot claim an endpoint-only overlap is merge-sufficient.
 */
export function overlapIsMergeSufficient(sharedAttributeNames: readonly string[]): boolean {
  return sharedAttributeNames.some((name) => mergeSufficientAttributeNames.has(name));
}
