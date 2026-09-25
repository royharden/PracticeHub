import {
  RcmShadowError,
  WP040_PACKAGE_ID,
  WP056_PACKAGE_ID,
  WP062_PACKAGE_ID,
  WP066_PACKAGE_ID,
  type EligibilityCheckpoint,
  type Wp040CoverageAnswer,
  type Wp040CoverageFixture,
  type Wp062ChargeFixture,
  type Wp062EncounterCharge,
  type Wp066MedicationFixture,
  type Wp066MedicationSource,
  type Wp056LedgerFixture,
  type Wp056LedgerPort,
  type Wp056LedgerPosting,
} from './contracts.js';

function isPosting(value: unknown): value is Wp056LedgerPosting {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const posting = value as Partial<Wp056LedgerPosting>;
  return (
    posting.packageId === WP056_PACKAGE_ID &&
    typeof posting.postingId === 'string' &&
    typeof posting.tenantId === 'string' &&
    typeof posting.amountMinor === 'number' &&
    posting.currency === 'USD' &&
    typeof posting.sourceSeal === 'string'
  );
}

export function parseWp056Fixture(raw: unknown): Wp056LedgerFixture {
  if (typeof raw !== 'object' || raw === null) {
    throw new RcmShadowError('WP056_FIXTURE', 'WP-056 fixture must be an object');
  }
  const fixture = raw as Partial<Wp056LedgerFixture>;
  if (fixture.packageId !== WP056_PACKAGE_ID || typeof fixture.standsFor !== 'string') {
    throw new RcmShadowError('WP056_FIXTURE', 'WP-056 fixture packageId must be WP-056');
  }
  if (!Array.isArray(fixture.postings) || !fixture.postings.every(isPosting)) {
    throw new RcmShadowError('WP056_FIXTURE', 'WP-056 fixture postings must use package WP-056');
  }
  return {
    packageId: WP056_PACKAGE_ID,
    standsFor: fixture.standsFor,
    postings: fixture.postings,
  };
}

export function wp056PlaceholderPort(fixture: Wp056LedgerFixture): Wp056LedgerPort {
  if (fixture.packageId !== WP056_PACKAGE_ID) {
    throw new RcmShadowError('WP056_PORT', 'placeholder port stands for WP-056');
  }
  const recorded: Wp056LedgerPosting[] = [...fixture.postings];
  return {
    packageId: WP056_PACKAGE_ID,
    record(posting: Wp056LedgerPosting): Wp056LedgerPosting {
      if (posting.packageId !== WP056_PACKAGE_ID) {
        throw new RcmShadowError('WP056_PORT', 'posting packageId must be WP-056');
      }
      recorded.push(posting);
      return posting;
    },
    postings(): readonly Wp056LedgerPosting[] {
      return recorded;
    },
  };
}

const CHECKPOINTS: readonly EligibilityCheckpoint[] = ['booking', 't48', 'day-of'];

function isCheckpoint(value: unknown): value is EligibilityCheckpoint {
  return CHECKPOINTS.some((checkpoint) => checkpoint === value);
}

function isCoverageAnswer(value: unknown): value is Wp040CoverageAnswer {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const answer = value as Partial<Wp040CoverageAnswer>;
  return (
    answer.packageId === WP040_PACKAGE_ID &&
    typeof answer.appointmentId === 'string' &&
    typeof answer.tenantId === 'string' &&
    isCheckpoint(answer.checkpoint) &&
    typeof answer.serviceAt === 'string'
  );
}

export function parseWp040Fixture(raw: unknown): Wp040CoverageFixture {
  if (typeof raw !== 'object' || raw === null) {
    throw new RcmShadowError('WP040_FIXTURE', 'WP-040 fixture must be an object');
  }
  const fixture = raw as Partial<Wp040CoverageFixture>;
  if (fixture.packageId !== WP040_PACKAGE_ID || typeof fixture.standsFor !== 'string') {
    throw new RcmShadowError('WP040_FIXTURE', 'WP-040 fixture packageId must be WP-040');
  }
  if (!Array.isArray(fixture.answers) || !fixture.answers.every(isCoverageAnswer)) {
    throw new RcmShadowError('WP040_FIXTURE', 'WP-040 fixture answers must use package WP-040');
  }
  return {
    packageId: WP040_PACKAGE_ID,
    standsFor: fixture.standsFor,
    answers: fixture.answers,
  };
}

function isMedicationSource(value: unknown): value is Wp066MedicationSource {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const source = value as Partial<Wp066MedicationSource>;
  return (
    source.packageId === WP066_PACKAGE_ID &&
    typeof source.medicationId === 'string' &&
    typeof source.tenantId === 'string' &&
    typeof source.daysOfSupplyRemaining === 'number' &&
    typeof source.nextFillInDays === 'number' &&
    (source.interimSource === null || typeof source.interimSource === 'string')
  );
}

export function parseWp066Fixture(raw: unknown): Wp066MedicationFixture {
  if (typeof raw !== 'object' || raw === null) {
    throw new RcmShadowError('WP066_FIXTURE', 'WP-066 fixture must be an object');
  }
  const fixture = raw as Partial<Wp066MedicationFixture>;
  if (fixture.packageId !== WP066_PACKAGE_ID || typeof fixture.standsFor !== 'string') {
    throw new RcmShadowError('WP066_FIXTURE', 'WP-066 fixture packageId must be WP-066');
  }
  if (!Array.isArray(fixture.sources) || !fixture.sources.every(isMedicationSource)) {
    throw new RcmShadowError('WP066_FIXTURE', 'WP-066 fixture sources must use package WP-066');
  }
  return {
    packageId: WP066_PACKAGE_ID,
    standsFor: fixture.standsFor,
    sources: fixture.sources,
  };
}

function isEncounterCharge(value: unknown): value is Wp062EncounterCharge {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const charge = value as Partial<Wp062EncounterCharge>;
  return (
    charge.packageId === WP062_PACKAGE_ID &&
    typeof charge.encounterId === 'string' &&
    typeof charge.tenantId === 'string' &&
    typeof charge.chargeId === 'string' &&
    typeof charge.amountMinor === 'number' &&
    charge.currency === 'USD'
  );
}

export function parseWp062Fixture(raw: unknown): Wp062ChargeFixture {
  if (typeof raw !== 'object' || raw === null) {
    throw new RcmShadowError('WP062_FIXTURE', 'WP-062 fixture must be an object');
  }
  const fixture = raw as Partial<Wp062ChargeFixture>;
  if (fixture.packageId !== WP062_PACKAGE_ID || typeof fixture.standsFor !== 'string') {
    throw new RcmShadowError('WP062_FIXTURE', 'WP-062 fixture packageId must be WP-062');
  }
  if (!Array.isArray(fixture.expected) || !fixture.expected.every(isEncounterCharge)) {
    throw new RcmShadowError('WP062_FIXTURE', 'WP-062 fixture charges must use package WP-062');
  }
  return {
    packageId: WP062_PACKAGE_ID,
    standsFor: fixture.standsFor,
    expected: fixture.expected,
  };
}
