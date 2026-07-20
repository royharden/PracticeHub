/**
 * Jurisdiction-as-data (WP-011). A versioned `JurisdictionRulePack` registry
 * (per jurisdiction × topic) with a strictest-law cascade resolver over the
 * two location facts (R6-SR-002; ADR-005 §5) and safe defaults on unknown
 * location. Contract: docs/contracts/jurisdiction-resolver.md (FROZEN).
 *
 * Adding a state is a rule pack + counsel sign-off (EW-025), never code
 * (NFR-14): a known state with no pack resolves through the `unknown`
 * safe-default pack with the gap named in `missingPacks` — conservative,
 * never a silent statutory answer and never a crash.
 */

import { TenancyInvariantError } from './tenancy.js';

/** Frozen topic vocabulary (ADR-005 §5) — extending it is a contract revision. */
export const jurisdictionTopics = [
  'recording-consent',
  'chd-rights',
  'genetic-authorization',
  'records-consent',
  'erx-epcs-pdmp',
  'telehealth-licensure',
  'auto-renewal',
  'retention',
  'biometrics',
  'ai-disclosure',
  'cpom',
  'minors-part2',
] as const;
export type JurisdictionTopic = (typeof jurisdictionTopics)[number];

/**
 * Frozen per-topic obligation vocabulary. A pack rule naming an obligation
 * outside its topic's vocabulary is rejected — obligations are a controlled
 * machine-readable surface, never free text.
 */
export const jurisdictionObligationVocabulary: Readonly<
  Record<JurisdictionTopic, readonly string[]>
> = {
  'recording-consent': ['one-party-consent', 'all-party-consent'],
  'chd-rights': [
    'chd-opt-in',
    'chd-sale-separate-authorization',
    'chd-geofence-ban',
    'chd-privacy-policy',
  ],
  'genetic-authorization': [
    'genetic-informed-consent',
    'gipa-written-authorization',
    'genetic-partition',
    'employer-carve-out',
  ],
  'records-consent': [
    'hipaa-authorization',
    'written-consent',
    'consent-expiry',
    'mh-heightened-consent',
  ],
  'erx-epcs-pdmp': [
    'erx-mandate',
    'epcs-two-factor',
    'pdmp-check',
    'prescriber-state-rules',
    'jurisdiction-unverified-hard-block',
  ],
  'telehealth-licensure': [
    'patient-presence-state-licensure',
    'hard-block-unlicensed',
    'jurisdiction-unverified-hard-block',
  ],
  'auto-renewal': [
    'strictest-state-standard',
    'renewal-reminder',
    'affirmative-consent-disclosure',
    'one-step-cancellation',
  ],
  retention: ['per-state-retention-clock', 'minor-extended-retention', 'legal-hold-override'],
  biometrics: [
    'no-biometric-enrollment-default',
    'biometric-consent',
    'bipa-written-release',
    'retention-destruction-schedule',
  ],
  'ai-disclosure': [
    'ai-disclosure',
    'no-ai-therapy-representation',
    'crisis-protocol',
    'human-oversight',
  ],
  cpom: ['pc-mso-split', 'counsel-structure-review'],
  'minors-part2': ['strictest-minor-confidentiality', 'part2-segmentation-ready'],
};

/**
 * Strictest direction per scalar key: `min` (a shorter consent life is more
 * protective) or `max` (a longer retention clock is more protective). A scalar
 * key outside this record is rejected.
 */
export const jurisdictionScalarDirections: Readonly<Record<string, 'min' | 'max'>> = {
  'consent-expiry-days': 'min',
  'retention-years-adult': 'max',
};

/** Pseudo-jurisdictions: the always-unioned platform floor and the safe default. */
export const floorJurisdiction = 'floor';
export const unknownJurisdiction = 'unknown';

const stateCodePattern = /^[A-Z]{2}$/;
const refPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;

export type PackStatus = 'draft' | 'counsel-signed';

export interface JurisdictionRule {
  readonly topic: JurisdictionTopic;
  readonly obligations: readonly string[];
  readonly scalars?: Readonly<Record<string, number>>;
  /** Statutory/source citation (state-matrix row or R6-SR id). */
  readonly sourceRef: string;
}

/**
 * One versioned rule pack for one jurisdiction. Packs are counsel-owned,
 * change-controlled data (EW-025): every pack carries a change-control ref;
 * `counsel-signed` additionally requires the sign-off ref. Prior versions stay
 * in the registry — reverting a pack is dropping its newest version, never
 * rewriting history.
 */
export interface JurisdictionRulePack {
  readonly jurisdiction: string;
  readonly version: number;
  readonly status: PackStatus;
  readonly counselSignoffRef?: string;
  readonly changeControlRef: string;
  readonly rules: readonly JurisdictionRule[];
  readonly synthetic: true;
}

export class JurisdictionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'JurisdictionError';
  }
}

function isJurisdictionTopic(value: string): value is JurisdictionTopic {
  return (jurisdictionTopics as readonly string[]).includes(value);
}

export function assertJurisdictionRulePackWellFormed(pack: JurisdictionRulePack): void {
  const label = `${pack.jurisdiction} v${pack.version}`;
  if (
    !stateCodePattern.test(pack.jurisdiction) &&
    pack.jurisdiction !== floorJurisdiction &&
    pack.jurisdiction !== unknownJurisdiction
  ) {
    throw new JurisdictionError(
      `pack ${label}: jurisdiction must be a two-letter state code, ` +
        `'${floorJurisdiction}', or '${unknownJurisdiction}'`,
    );
  }
  if (!Number.isInteger(pack.version) || pack.version < 1) {
    throw new JurisdictionError(`pack ${label}: version must be a positive integer`);
  }
  if (pack.synthetic !== true) {
    throw new JurisdictionError(`pack ${label}: missing the synthetic watermark`);
  }
  if (!refPattern.test(pack.changeControlRef)) {
    throw new JurisdictionError(
      `pack ${label}: requires a change-control reference (counsel-owned data fails closed)`,
    );
  }
  if (pack.status === 'counsel-signed' && !pack.counselSignoffRef) {
    throw new JurisdictionError(
      `pack ${label}: counsel-signed status requires a counsel sign-off reference (EW-025)`,
    );
  }
  const seenTopics = new Set<string>();
  for (const rule of pack.rules) {
    if (!isJurisdictionTopic(rule.topic)) {
      throw new JurisdictionError(`pack ${label}: unknown topic ${JSON.stringify(rule.topic)}`);
    }
    if (seenTopics.has(rule.topic)) {
      throw new JurisdictionError(`pack ${label}: duplicate topic ${rule.topic}`);
    }
    seenTopics.add(rule.topic);
    const vocabulary = jurisdictionObligationVocabulary[rule.topic];
    for (const obligation of rule.obligations) {
      if (!vocabulary.includes(obligation)) {
        throw new JurisdictionError(
          `pack ${label}: obligation ${JSON.stringify(obligation)} is outside the ` +
            `${rule.topic} vocabulary`,
        );
      }
    }
    for (const [key, value] of Object.entries(rule.scalars ?? {})) {
      if (!(key in jurisdictionScalarDirections)) {
        throw new JurisdictionError(
          `pack ${label}: scalar ${JSON.stringify(key)} has no declared strictest direction`,
        );
      }
      if (!Number.isFinite(value) || value <= 0) {
        throw new JurisdictionError(`pack ${label}: scalar ${key} must be a positive number`);
      }
    }
    if (!rule.sourceRef.trim()) {
      throw new JurisdictionError(`pack ${label}: rule ${rule.topic} requires a source reference`);
    }
  }
  // Every pack covers every topic, so a resolution can never fall through a
  // topic gap silently. The unknown pack is the safe-default floor: an empty
  // obligation set there would make "fail closed" vacuous.
  for (const topic of jurisdictionTopics) {
    if (!seenTopics.has(topic)) {
      throw new JurisdictionError(`pack ${label}: missing topic ${topic}`);
    }
  }
  if (pack.jurisdiction === unknownJurisdiction) {
    for (const rule of pack.rules) {
      if (rule.obligations.length === 0) {
        throw new JurisdictionError(
          `pack ${label}: the unknown-jurisdiction safe default for ${rule.topic} ` +
            'must not be empty (fail-closed)',
        );
      }
    }
  }
}

/**
 * Validate a registry: every pack well-formed, no duplicate (jurisdiction,
 * version), and the floor + unknown packs present — the resolver refuses to
 * run without its fail-closed substrate.
 */
export function assertJurisdictionRegistryWellFormed(packs: readonly JurisdictionRulePack[]): void {
  const seen = new Set<string>();
  for (const pack of packs) {
    assertJurisdictionRulePackWellFormed(pack);
    const key = `${pack.jurisdiction}@${pack.version}`;
    if (seen.has(key)) {
      throw new JurisdictionError(`duplicate pack ${key}`);
    }
    seen.add(key);
  }
  for (const required of [floorJurisdiction, unknownJurisdiction]) {
    if (!packs.some((pack) => pack.jurisdiction === required)) {
      throw new JurisdictionError(`registry is missing the '${required}' pack`);
    }
  }
}

function activePack(
  packs: readonly JurisdictionRulePack[],
  jurisdiction: string,
): JurisdictionRulePack | undefined {
  return packs
    .filter((pack) => pack.jurisdiction === jurisdiction)
    .sort((left, right) => right.version - left.version)[0];
}

/**
 * The two location facts (R6-SR-002): provider licensure/service state and
 * patient physical-presence state. `null` = unknown — resolved through the
 * safe-default pack, never skipped.
 */
export interface JurisdictionBasis {
  readonly providerState: string | null;
  readonly patientState: string | null;
}

export interface JurisdictionContribution {
  readonly fact: 'provider' | 'patient' | 'floor';
  readonly jurisdiction: string;
  readonly packVersion: number;
  readonly packStatus: PackStatus;
  readonly obligations: readonly string[];
  readonly scalars: Readonly<Record<string, number>>;
  /** True when this fact resolved through the safe-default pack. */
  readonly defaultsApplied: boolean;
  /** Set when a known state had no pack (NFR-14 fifth-state path). */
  readonly missingPack?: string;
}

export interface JurisdictionResolution {
  readonly topic: JurisdictionTopic;
  /** Sorted union of every contribution — the most protective combined set. */
  readonly obligations: readonly string[];
  /** Strictest value per scalar key (direction per jurisdictionScalarDirections). */
  readonly scalars: Readonly<Record<string, number>>;
  readonly contributions: readonly JurisdictionContribution[];
  readonly defaultsApplied: boolean;
  readonly missingPacks: readonly string[];
  /** True while any contributing pack lacks counsel sign-off (EW-025 pending). */
  readonly counselReviewPending: boolean;
}

function contributionFor(
  packs: readonly JurisdictionRulePack[],
  fact: 'provider' | 'patient' | 'floor',
  state: string | null,
  topic: JurisdictionTopic,
): JurisdictionContribution {
  let jurisdiction: string;
  let defaultsApplied = false;
  let missingPack: string | undefined;
  if (fact === 'floor') {
    jurisdiction = floorJurisdiction;
  } else if (state === null) {
    jurisdiction = unknownJurisdiction;
    defaultsApplied = true;
  } else if (!stateCodePattern.test(state)) {
    throw new JurisdictionError(
      `${fact} state must be a two-letter state code or null; received ${JSON.stringify(state)}`,
    );
  } else if (activePack(packs, state) === undefined) {
    jurisdiction = unknownJurisdiction;
    defaultsApplied = true;
    missingPack = state;
  } else {
    jurisdiction = state;
  }
  const pack = activePack(packs, jurisdiction);
  if (pack === undefined) {
    throw new JurisdictionError(`registry is missing the '${jurisdiction}' pack`);
  }
  const rule = pack.rules.find((candidate) => candidate.topic === topic);
  if (rule === undefined) {
    throw new JurisdictionError(`pack ${jurisdiction} v${pack.version} has no ${topic} rule`);
  }
  return {
    fact,
    jurisdiction,
    packVersion: pack.version,
    packStatus: pack.status,
    obligations: rule.obligations,
    scalars: rule.scalars ?? {},
    defaultsApplied,
    ...(missingPack !== undefined ? { missingPack } : {}),
  };
}

/**
 * Strictest-law cascade (R6-SR-002): the resolution is the UNION of the
 * obligations contributed by the provider-state fact, the patient-state fact,
 * and the always-applied platform floor, with scalar obligations reduced to
 * the strictest value per declared direction. Unknown facts and unpacked
 * states contribute the safe-default pack — a mis-detected or missing
 * location fails safe, never permissive.
 */
export function resolveJurisdiction(
  packs: readonly JurisdictionRulePack[],
  basis: JurisdictionBasis,
  topic: JurisdictionTopic,
): JurisdictionResolution {
  if (!isJurisdictionTopic(topic)) {
    throw new JurisdictionError(`unknown jurisdiction topic ${JSON.stringify(topic)}`);
  }
  assertJurisdictionRegistryWellFormed(packs);
  const contributions = [
    contributionFor(packs, 'provider', basis.providerState, topic),
    contributionFor(packs, 'patient', basis.patientState, topic),
    contributionFor(packs, 'floor', null, topic),
  ];
  const obligations = [
    ...new Set(contributions.flatMap((contribution) => contribution.obligations)),
  ].sort();
  const scalars: Record<string, number> = {};
  for (const contribution of contributions) {
    for (const [key, value] of Object.entries(contribution.scalars)) {
      const direction = jurisdictionScalarDirections[key];
      if (direction === undefined) {
        throw new JurisdictionError(`scalar ${key} has no declared strictest direction`);
      }
      const current = scalars[key];
      if (current === undefined || (direction === 'min' ? value < current : value > current)) {
        scalars[key] = value;
      }
    }
  }
  return {
    topic,
    obligations,
    scalars,
    contributions,
    defaultsApplied: contributions.some((contribution) => contribution.defaultsApplied),
    missingPacks: [
      ...new Set(
        contributions
          .map((contribution) => contribution.missingPack)
          .filter((state): state is string => state !== undefined),
      ),
    ].sort(),
    counselReviewPending: contributions.some(
      (contribution) => contribution.packStatus !== 'counsel-signed',
    ),
  };
}

// --- Location capture (R6-SR-001, M01 slice) -------------------------------

export const locationCaptureStages = ['booking', 'visit-start'] as const;
export type LocationCaptureStage = (typeof locationCaptureStages)[number];

/**
 * One captured patient-location fact for a regulated-action context. Captured
 * at booking AND re-confirmed at visit start; when they differ, BOTH records
 * are retained with their timestamps (divergence retention). `stateCode` null
 * = the patient's state could not be established — the resolver then applies
 * the safe defaults. Append-only: corrections are new rows, never updates
 * (the DB revokes UPDATE/DELETE from the module role).
 */
export interface LocationFact {
  readonly tenantId: string;
  readonly captureId: string;
  readonly contextRef: string;
  readonly stage: LocationCaptureStage;
  readonly stateCode: string | null;
  readonly capturedAt: string;
  readonly source: string;
  readonly synthetic: true;
}

const captureIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertLocationFactWellFormed(fact: LocationFact): void {
  if (!captureIdPattern.test(fact.captureId)) {
    throw new TenancyInvariantError(
      `captureId must match ${captureIdPattern.source}; received ${JSON.stringify(fact.captureId)}`,
    );
  }
  if (!refPattern.test(fact.contextRef)) {
    throw new TenancyInvariantError(
      `contextRef must match ${refPattern.source}; received ${JSON.stringify(fact.contextRef)}`,
    );
  }
  if (!(locationCaptureStages as readonly string[]).includes(fact.stage)) {
    throw new TenancyInvariantError(`unknown capture stage ${JSON.stringify(fact.stage)}`);
  }
  if (fact.stateCode !== null && !stateCodePattern.test(fact.stateCode)) {
    throw new TenancyInvariantError(
      `stateCode must be a two-letter state code or null; received ${JSON.stringify(fact.stateCode)}`,
    );
  }
  if (Number.isNaN(Date.parse(fact.capturedAt))) {
    throw new TenancyInvariantError(
      `capturedAt must be a parseable timestamp; received ${JSON.stringify(fact.capturedAt)}`,
    );
  }
  if (fact.synthetic !== true) {
    throw new TenancyInvariantError(`capture ${fact.captureId} is missing the synthetic watermark`);
  }
}

function latestFact(
  facts: readonly LocationFact[],
  stage: LocationCaptureStage,
): LocationFact | undefined {
  return facts
    .filter((fact) => fact.stage === stage)
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))[0];
}

export interface LocationDivergence {
  readonly diverged: boolean;
  readonly bookingFact?: LocationFact;
  readonly visitStartFact?: LocationFact;
  /** Every retained fact for the context — divergence never discards a record. */
  readonly retained: readonly LocationFact[];
}

/**
 * Divergence view over a context's captured facts (R6-SR-001): the latest
 * booking fact and the latest visit-start fact, flagged diverged when both
 * exist and disagree (including known-vs-unknown). All facts stay retained.
 */
export function locationDivergence(facts: readonly LocationFact[]): LocationDivergence {
  for (const fact of facts) {
    assertLocationFactWellFormed(fact);
  }
  const contexts = new Set(facts.map((fact) => `${fact.tenantId}/${fact.contextRef}`));
  if (contexts.size > 1) {
    throw new TenancyInvariantError(
      `divergence is computed per context; received ${[...contexts].sort().join(', ')}`,
    );
  }
  const bookingFact = latestFact(facts, 'booking');
  const visitStartFact = latestFact(facts, 'visit-start');
  return {
    diverged:
      bookingFact !== undefined &&
      visitStartFact !== undefined &&
      bookingFact.stateCode !== visitStartFact.stateCode,
    ...(bookingFact !== undefined ? { bookingFact } : {}),
    ...(visitStartFact !== undefined ? { visitStartFact } : {}),
    retained: facts,
  };
}

/**
 * Derive the resolver basis from the provider/service state and a context's
 * captured patient facts: the visit-start fact governs when present
 * (R6-SR-004 hands re-evaluation to the visit flow), else booking, else
 * unknown — which resolves through the safe defaults, never permissively.
 */
export function resolutionBasisFromFacts(
  providerState: string | null,
  facts: readonly LocationFact[],
): JurisdictionBasis {
  const { bookingFact, visitStartFact } = locationDivergence(facts);
  const governing = visitStartFact ?? bookingFact;
  return {
    providerState,
    patientState: governing?.stateCode ?? null,
  };
}
