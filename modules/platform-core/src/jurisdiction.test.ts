import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import type {
  JurisdictionBasis,
  JurisdictionResolution,
  JurisdictionRulePack,
  JurisdictionTopic,
  LocationFact,
} from './jurisdiction.js';
import {
  assertJurisdictionRegistryWellFormed,
  assertJurisdictionRulePackWellFormed,
  assertLocationFactWellFormed,
  JurisdictionError,
  jurisdictionTopics,
  locationDivergence,
  resolutionBasisFromFacts,
  resolveJurisdiction,
} from './jurisdiction.js';
import {
  jurisdictionPacksV1,
  jurisdictionSeedBeginMarker,
  jurisdictionSeedEndMarker,
  renderJurisdictionSeedSection,
} from './jurisdiction-packs.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const seedPath = fileURLToPath(
  new URL('../../../infra/postgres/seed/004-jurisdiction-seed.sql', import.meta.url),
);
const truthTablePath = fileURLToPath(
  new URL('../fixtures/jurisdiction-truth-table.json', import.meta.url),
);

/**
 * The truth-table domain (verification gate: all states × topics): the four
 * footprint states, one deliberately unpacked state (CA — the NFR-14
 * fifth-state path), and the unknown location, on both facts.
 */
const truthTableStates: readonly (string | null)[] = ['NV', 'FL', 'IL', 'MN', 'CA', null];

interface TruthTableCell {
  readonly obligations: readonly string[];
  readonly scalars: Readonly<Record<string, number>>;
  readonly defaultsApplied: boolean;
  readonly missingPacks: readonly string[];
}

function truthTableCell(resolution: JurisdictionResolution): TruthTableCell {
  return {
    obligations: resolution.obligations,
    scalars: resolution.scalars,
    defaultsApplied: resolution.defaultsApplied,
    missingPacks: resolution.missingPacks,
  };
}

function computeTruthTable(): Record<string, TruthTableCell> {
  const table: Record<string, TruthTableCell> = {};
  for (const topic of jurisdictionTopics) {
    for (const providerState of truthTableStates) {
      for (const patientState of truthTableStates) {
        const key = `${topic}|${providerState ?? 'unknown'}|${patientState ?? 'unknown'}`;
        table[key] = truthTableCell(
          resolveJurisdiction(jurisdictionPacksV1, { providerState, patientState }, topic),
        );
      }
    }
  }
  return table;
}

describe('jurisdiction rule-pack registry', () => {
  it('the v1 registry of record is well-formed', () => {
    expect(() => assertJurisdictionRegistryWellFormed(jurisdictionPacksV1)).not.toThrow();
  });

  it('rejects a pack naming an obligation outside its topic vocabulary', () => {
    const pack = jurisdictionPacksV1[0] as JurisdictionRulePack;
    const corrupted: JurisdictionRulePack = {
      ...pack,
      rules: pack.rules.map((rule) =>
        rule.topic === 'recording-consent'
          ? { ...rule, obligations: ['all-party-consent', 'not-an-obligation'] }
          : rule,
      ),
    };
    expect(() => assertJurisdictionRulePackWellFormed(corrupted)).toThrow(
      /outside the recording-consent vocabulary/,
    );
  });

  it('rejects a pack missing a topic — no silent topic gaps', () => {
    const pack = jurisdictionPacksV1[0] as JurisdictionRulePack;
    const partial: JurisdictionRulePack = {
      ...pack,
      rules: pack.rules.filter((rule) => rule.topic !== 'retention'),
    };
    expect(() => assertJurisdictionRulePackWellFormed(partial)).toThrow(/missing topic retention/);
  });

  it('rejects an unknown-jurisdiction pack with an empty safe default (fail-closed)', () => {
    const unknownPack = jurisdictionPacksV1.find(
      (pack) => pack.jurisdiction === 'unknown',
    ) as JurisdictionRulePack;
    const weakened: JurisdictionRulePack = {
      ...unknownPack,
      rules: unknownPack.rules.map((rule) =>
        rule.topic === 'recording-consent' ? { ...rule, obligations: [] } : rule,
      ),
    };
    expect(() => assertJurisdictionRulePackWellFormed(weakened)).toThrow(/must not be empty/);
  });

  it('rejects counsel-signed status without a sign-off reference (EW-025 evidenced)', () => {
    const pack = jurisdictionPacksV1[0] as JurisdictionRulePack;
    expect(() =>
      assertJurisdictionRulePackWellFormed({ ...pack, status: 'counsel-signed' }),
    ).toThrow(/counsel sign-off reference/);
  });

  it('rejects a registry without the floor or unknown packs', () => {
    const withoutUnknown = jurisdictionPacksV1.filter((pack) => pack.jurisdiction !== 'unknown');
    expect(() => assertJurisdictionRegistryWellFormed(withoutUnknown)).toThrow(
      /missing the 'unknown' pack/,
    );
    const withoutFloor = jurisdictionPacksV1.filter((pack) => pack.jurisdiction !== 'floor');
    expect(() => assertJurisdictionRegistryWellFormed(withoutFloor)).toThrow(
      /missing the 'floor' pack/,
    );
  });

  it('rejects duplicate (jurisdiction, version) packs and undeclared scalars', () => {
    expect(() =>
      assertJurisdictionRegistryWellFormed([
        ...jurisdictionPacksV1,
        jurisdictionPacksV1[0] as JurisdictionRulePack,
      ]),
    ).toThrow(/duplicate pack/);
    const pack = jurisdictionPacksV1[0] as JurisdictionRulePack;
    expect(() =>
      assertJurisdictionRulePackWellFormed({
        ...pack,
        rules: pack.rules.map((rule) =>
          rule.topic === 'retention' ? { ...rule, scalars: { 'not-a-scalar': 5 } } : rule,
        ),
      }),
    ).toThrow(/no declared strictest direction/);
  });
});

describe('strictest-law cascade resolver — hand-derived anchors (R6-SR-002)', () => {
  const resolve = (
    providerState: string | null,
    patientState: string | null,
    topic: JurisdictionTopic,
  ): JurisdictionResolution =>
    resolveJurisdiction(jurisdictionPacksV1, { providerState, patientState }, topic);

  it('NV provider × FL patient recording resolves all-party', () => {
    expect(resolve('NV', 'FL', 'recording-consent').obligations).toEqual(['all-party-consent']);
  });

  it('MN × MN recording still carries all-party — the floor never relaxes', () => {
    const resolution = resolve('MN', 'MN', 'recording-consent');
    expect(resolution.obligations).toContain('all-party-consent');
    expect(resolution.contributions.find((c) => c.fact === 'floor')?.obligations).toContain(
      'all-party-consent',
    );
  });

  it('genetic data gets GIPA-grade controls regardless of state pair (floor)', () => {
    for (const pair of [
      ['NV', 'NV'],
      ['FL', 'MN'],
      ['MN', 'FL'],
    ] as const) {
      const resolution = resolve(pair[0], pair[1], 'genetic-authorization');
      expect(resolution.obligations).toContain('gipa-written-authorization');
      expect(resolution.obligations).toContain('employer-carve-out');
      expect(resolution.obligations).toContain('genetic-partition');
    }
  });

  it('MN records-consent contributes written consent with a 365-day expiry', () => {
    const resolution = resolve('NV', 'MN', 'records-consent');
    expect(resolution.obligations).toEqual([
      'consent-expiry',
      'hipaa-authorization',
      'written-consent',
    ]);
    expect(resolution.scalars).toEqual({ 'consent-expiry-days': 365 });
  });

  it('retention takes the longest clock across the pair (max direction)', () => {
    expect(resolve('IL', 'NV', 'retention').scalars).toEqual({ 'retention-years-adult': 10 });
    expect(resolve('NV', 'FL', 'retention').scalars).toEqual({ 'retention-years-adult': 5 });
  });

  it('consent expiry takes the shortest life across the pair (min direction)', () => {
    const mn = jurisdictionPacksV1.find(
      (pack) => pack.jurisdiction === 'MN',
    ) as JurisdictionRulePack;
    const shorterExpiryState: JurisdictionRulePack = {
      ...mn,
      jurisdiction: 'WA',
      changeControlRef: 'synthetic-ccr-jur-wa-fixture',
      rules: mn.rules.map((rule) =>
        rule.topic === 'records-consent'
          ? { ...rule, scalars: { 'consent-expiry-days': 180 } }
          : rule,
      ),
    };
    const resolution = resolveJurisdiction(
      [...jurisdictionPacksV1, shorterExpiryState],
      { providerState: 'WA', patientState: 'MN' },
      'records-consent',
    );
    expect(resolution.scalars).toEqual({ 'consent-expiry-days': 180 });
  });

  it('an unknown patient location resolves through the safe defaults, never permissively', () => {
    const resolution = resolve('NV', null, 'telehealth-licensure');
    expect(resolution.defaultsApplied).toBe(true);
    expect(resolution.obligations).toContain('jurisdiction-unverified-hard-block');
    expect(resolution.missingPacks).toEqual([]);
  });

  it('NFR-14: a state with no pack resolves conservatively and names the gap', () => {
    const resolution = resolve('CA', 'NV', 'erx-epcs-pdmp');
    expect(resolution.defaultsApplied).toBe(true);
    expect(resolution.missingPacks).toEqual(['CA']);
    expect(resolution.obligations).toContain('jurisdiction-unverified-hard-block');
  });

  it('draft packs surface counselReviewPending (EW-025 not evidenced yet)', () => {
    expect(resolve('NV', 'FL', 'recording-consent').counselReviewPending).toBe(true);
  });

  it('rejects an unknown topic and a malformed state code', () => {
    expect(() =>
      resolveJurisdiction(
        jurisdictionPacksV1,
        { providerState: 'NV', patientState: 'FL' },
        'not-a-topic' as JurisdictionTopic,
      ),
    ).toThrow(JurisdictionError);
    expect(() => resolve('nv', 'FL', 'recording-consent')).toThrow(/two-letter state code/);
  });

  it('domain invariants: recording is always all-party; AI surfaces always disclose', () => {
    for (const providerState of truthTableStates) {
      for (const patientState of truthTableStates) {
        const basis: JurisdictionBasis = { providerState, patientState };
        expect(
          resolveJurisdiction(jurisdictionPacksV1, basis, 'recording-consent').obligations,
        ).toContain('all-party-consent');
        const ai = resolveJurisdiction(jurisdictionPacksV1, basis, 'ai-disclosure');
        expect(ai.obligations).toContain('ai-disclosure');
        expect(ai.obligations).toContain('no-ai-therapy-representation');
        expect(ai.obligations).toContain('crisis-protocol');
        expect(ai.obligations).toContain('human-oversight');
      }
    }
  });
});

describe('rule-change regression harness (verification gate)', () => {
  it('TRUTH-TABLE: every state×topic resolution matches the committed table', () => {
    const committed = JSON.parse(readFileSync(truthTablePath, 'utf8')) as {
      synthetic: true;
      packsVersion: string;
      cells: Record<string, TruthTableCell>;
    };
    expect(committed.synthetic).toBe(true);
    const computed = computeTruthTable();
    expect(
      Object.keys(committed.cells).length,
      'committed truth table must cover the full domain',
    ).toBe(jurisdictionTopics.length * truthTableStates.length * truthTableStates.length);
    // Cell-by-cell comparison so a rule change names exactly the resolutions
    // it moved; regenerating the table is a deliberate, change-controlled act.
    for (const [key, cell] of Object.entries(computed)) {
      expect(committed.cells[key], `truth-table cell ${key}`).toEqual(cell);
    }
  });

  it('SEED-DRIFT: the committed 004 seed embeds exactly the generated registry section', () => {
    const seed = readFileSync(seedPath, 'utf8');
    const begin = seed.indexOf(jurisdictionSeedBeginMarker);
    const end = seed.indexOf(jurisdictionSeedEndMarker);
    expect(begin, 'seed must carry the generated markers').toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const embedded = seed.slice(begin, end + jurisdictionSeedEndMarker.length);
    expect(embedded.replaceAll('\r\n', '\n')).toBe(
      renderJurisdictionSeedSection(jurisdictionPacksV1),
    );
  });
});

// --- Fixture packs (4-class floor per requirement) --------------------------

interface ResolutionExpectation {
  readonly obligations?: readonly string[];
  readonly obligationsInclude?: readonly string[];
  readonly scalars?: Readonly<Record<string, number>>;
  readonly defaultsApplied?: boolean;
  readonly missingPacks?: readonly string[];
  readonly counselReviewPending?: boolean;
  readonly contributionVersions?: Readonly<Record<string, number>>;
}

function expectResolution(
  resolution: JurisdictionResolution,
  expectation: ResolutionExpectation,
): void {
  if (expectation.obligations !== undefined) {
    expect(resolution.obligations).toEqual(expectation.obligations);
  }
  for (const obligation of expectation.obligationsInclude ?? []) {
    expect(resolution.obligations).toContain(obligation);
  }
  if (expectation.scalars !== undefined) {
    expect(resolution.scalars).toEqual(expectation.scalars);
  }
  if (expectation.defaultsApplied !== undefined) {
    expect(resolution.defaultsApplied).toBe(expectation.defaultsApplied);
  }
  if (expectation.missingPacks !== undefined) {
    expect(resolution.missingPacks).toEqual(expectation.missingPacks);
  }
  if (expectation.counselReviewPending !== undefined) {
    expect(resolution.counselReviewPending).toBe(expectation.counselReviewPending);
  }
  for (const [fact, version] of Object.entries(expectation.contributionVersions ?? {})) {
    expect(
      resolution.contributions.find((contribution) => contribution.fact === fact)?.packVersion,
      `${fact} contribution pack version`,
    ).toBe(version);
  }
}

interface ResolverFixtureCase {
  readonly name: string;
  readonly packIndexes?: readonly number[];
  readonly basis: JurisdictionBasis;
  readonly topic: string;
  readonly expect?: ResolutionExpectation;
  readonly expectError?: string;
}

interface ResolverFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly packs: 'v1' | 'inline';
  readonly packsInline?: readonly JurisdictionRulePack[];
  readonly cases: readonly ResolverFixtureCase[];
}

function resolverFixturePacks(
  fixture: ResolverFixture,
  fixtureCase: ResolverFixtureCase,
): readonly JurisdictionRulePack[] {
  const base = fixture.packs === 'v1' ? jurisdictionPacksV1 : (fixture.packsInline ?? []);
  if (fixtureCase.packIndexes === undefined) {
    return base;
  }
  return fixtureCase.packIndexes.map((index) => {
    const pack = base[index];
    if (pack === undefined) {
      throw new Error(`case ${fixtureCase.name} references missing pack ${index}`);
    }
    return pack;
  });
}

describe('R6-SR-002 fixture pack (strictest-law cascade engine)', () => {
  const pack = loadRequirementFixturePack(fixturesDirectory, 'R6-SR-002');
  for (const fixtureClass of requiredFixtureClasses) {
    const fixture = pack.fixtures[fixtureClass] as ResolverFixture;
    describe(`R6-SR-002 ${fixtureClass}`, () => {
      for (const fixtureCase of fixture.cases) {
        it(fixtureCase.name, () => {
          const packs = resolverFixturePacks(fixture, fixtureCase);
          const run = (): JurisdictionResolution =>
            resolveJurisdiction(packs, fixtureCase.basis, fixtureCase.topic as JurisdictionTopic);
          if (fixtureCase.expectError !== undefined) {
            expect(run).toThrow(new RegExp(fixtureCase.expectError));
            return;
          }
          expectResolution(run(), fixtureCase.expect ?? {});
        });
      }
    });
  }
});

interface LocationFixtureCase {
  readonly name: string;
  readonly kind: 'divergence' | 'basis' | 'resolve' | 'fact-invalid';
  readonly factIndexes?: readonly number[];
  readonly providerState?: string | null;
  readonly topic?: string;
  readonly expect?: {
    readonly diverged?: boolean;
    readonly bookingState?: string | null;
    readonly visitStartState?: string | null;
    readonly retainedCount?: number;
    readonly basis?: JurisdictionBasis;
    readonly resolution?: ResolutionExpectation;
  };
  readonly expectError?: string;
}

interface LocationFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly facts: readonly LocationFact[];
  readonly cases: readonly LocationFixtureCase[];
}

describe('R6-SR-001 fixture pack (two location facts + divergence retention)', () => {
  const pack = loadRequirementFixturePack(fixturesDirectory, 'R6-SR-001');
  for (const fixtureClass of requiredFixtureClasses) {
    const fixture = pack.fixtures[fixtureClass] as LocationFixture;
    describe(`R6-SR-001 ${fixtureClass}`, () => {
      for (const fixtureCase of fixture.cases) {
        it(fixtureCase.name, () => {
          const facts =
            fixtureCase.factIndexes?.map((index) => {
              const fact = fixture.facts[index];
              if (fact === undefined) {
                throw new Error(`case ${fixtureCase.name} references missing fact ${index}`);
              }
              return fact;
            }) ?? fixture.facts;
          if (fixtureCase.kind === 'fact-invalid') {
            expect(() => {
              for (const fact of facts) {
                assertLocationFactWellFormed(fact);
              }
              locationDivergence(facts);
            }).toThrow(new RegExp(fixtureCase.expectError ?? '.'));
            return;
          }
          if (fixtureCase.kind === 'divergence') {
            const divergence = locationDivergence(facts);
            const expected = fixtureCase.expect ?? {};
            if (expected.diverged !== undefined) {
              expect(divergence.diverged).toBe(expected.diverged);
            }
            if (expected.bookingState !== undefined) {
              expect(divergence.bookingFact?.stateCode ?? null).toBe(expected.bookingState);
            }
            if (expected.visitStartState !== undefined) {
              expect(divergence.visitStartFact?.stateCode ?? null).toBe(expected.visitStartState);
            }
            if (expected.retainedCount !== undefined) {
              expect(divergence.retained).toHaveLength(expected.retainedCount);
            }
            return;
          }
          const basis = resolutionBasisFromFacts(fixtureCase.providerState ?? null, facts);
          if (fixtureCase.kind === 'basis') {
            expect(basis).toEqual(fixtureCase.expect?.basis);
            return;
          }
          expectResolution(
            resolveJurisdiction(jurisdictionPacksV1, basis, fixtureCase.topic as JurisdictionTopic),
            fixtureCase.expect?.resolution ?? {},
          );
        });
      }
    });
  }
});
