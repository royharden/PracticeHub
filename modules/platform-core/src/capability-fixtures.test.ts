import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  CapabilityDeniedError,
  evaluateCapabilityTransition,
  foldCapabilityEvents,
  listGrantMatrix,
  requireCapability,
  transitionHistory,
  type CapabilityContext,
  type CapabilityGrant,
  type CapabilityId,
  type CapabilityState,
  type CapabilityTransitionEvent,
  type CapabilityTransitionRequest,
  type GrantMatrixFilter,
} from './capability.js';
import {
  capabilityRegistryV1,
  capabilitySeedBeginMarker,
  capabilitySeedEndMarker,
  renderCapabilitySeedSection,
  syntheticCapabilitySeedV1,
} from './capability-definitions.js';

const registry = capabilityRegistryV1;
const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

interface FixtureCase {
  readonly name: string;
  readonly op: 'matrix' | 'require' | 'grant-invalid' | 'transition' | 'history';
  readonly filter?: GrantMatrixFilter;
  readonly expectRows?: readonly {
    readonly capabilityId: CapabilityId;
    readonly scopeKey: string;
    readonly state: CapabilityState;
    readonly hasEvidence?: boolean;
  }[];
  readonly context?: CapabilityContext;
  readonly capabilityId?: CapabilityId;
  readonly minimumState?: CapabilityState;
  readonly foldEvents?: number;
  readonly expect?: {
    readonly allowed?: boolean;
    readonly grantState?: CapabilityState;
    readonly grantScopeKey?: string | null;
    readonly sinceEventId?: string | null;
  };
  readonly expectDenied?: string;
  readonly grant?: CapabilityGrant;
  readonly expectError?: string;
  readonly request?: CapabilityTransitionRequest;
  readonly expectDenials?: readonly string[];
  readonly scopeKey?: string;
  readonly expectCount?: number;
}

interface CapabilityFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly grants?: readonly CapabilityGrant[];
  readonly events?: readonly CapabilityTransitionEvent[];
  readonly cases: readonly FixtureCase[];
}

function caseGrants(
  fixture: CapabilityFixture,
  fixtureCase: FixtureCase,
): readonly CapabilityGrant[] {
  const base = fixture.grants ?? [];
  if (fixtureCase.foldEvents === undefined) {
    return base;
  }
  const folded = foldCapabilityEvents(
    registry,
    [],
    (fixture.events ?? []).slice(0, fixtureCase.foldEvents),
  );
  return [...base, ...folded];
}

function runCase(fixture: CapabilityFixture, fixtureCase: FixtureCase): void {
  const grants = caseGrants(fixture, fixtureCase);
  switch (fixtureCase.op) {
    case 'matrix': {
      const rows = listGrantMatrix(registry, grants, fixtureCase.filter ?? {});
      expect(
        rows.map((row) => ({
          capabilityId: row.capabilityId,
          scopeKey: row.scopeKey,
          state: row.state,
          hasEvidence: row.evidenceRefs.length > 0,
        })),
      ).toEqual(fixtureCase.expectRows);
      break;
    }
    case 'require': {
      const invoke = (): ReturnType<typeof requireCapability> =>
        requireCapability(
          registry,
          grants,
          fixtureCase.context ?? { tenantId: 'northwind-synthetic', scope: {} },
          fixtureCase.capabilityId ?? 'platform.bootstrap',
          fixtureCase.minimumState === undefined ? {} : { minimumState: fixtureCase.minimumState },
        );
      if (fixtureCase.expectDenied !== undefined) {
        try {
          invoke();
          expect.unreachable(`expected denial containing ${fixtureCase.expectDenied}`);
        } catch (error) {
          expect(error).toBeInstanceOf(CapabilityDeniedError);
          expect((error as CapabilityDeniedError).decision.allowed).toBe(false);
          expect((error as CapabilityDeniedError).decision.reason).toContain(
            fixtureCase.expectDenied,
          );
        }
        break;
      }
      const decision = invoke();
      const expected = fixtureCase.expect ?? {};
      if (expected.allowed !== undefined) {
        expect(decision.allowed).toBe(expected.allowed);
      }
      if (expected.grantState !== undefined) {
        expect(decision.grantState).toBe(expected.grantState);
      }
      if (expected.grantScopeKey !== undefined) {
        expect(decision.grantScopeKey).toBe(expected.grantScopeKey);
      }
      if (expected.sinceEventId !== undefined) {
        expect(decision.sinceEventId).toBe(expected.sinceEventId);
      }
      break;
    }
    case 'grant-invalid': {
      expect(fixtureCase.grant).toBeDefined();
      expect(() => listGrantMatrix(registry, [fixtureCase.grant as CapabilityGrant])).toThrow(
        fixtureCase.expectError ?? 'invalid',
      );
      break;
    }
    case 'transition': {
      expect(fixtureCase.request).toBeDefined();
      const evaluation = evaluateCapabilityTransition(
        registry,
        grants,
        fixtureCase.request as CapabilityTransitionRequest,
      );
      expect(evaluation.allowed).toBe(false);
      for (const code of fixtureCase.expectDenials ?? []) {
        expect(evaluation.denials.map((denial) => denial.code)).toContain(code);
      }
      break;
    }
    case 'history': {
      const events = transitionHistory(fixture.events ?? [], {
        ...(fixtureCase.scopeKey === undefined ? {} : { scopeKey: fixtureCase.scopeKey }),
      });
      expect(events).toHaveLength(fixtureCase.expectCount ?? 0);
      break;
    }
  }
}

describe('REQ-PLAT-012 fixture pack (4-class floor)', () => {
  const pack = loadRequirementFixturePack(fixturesDirectory, 'REQ-PLAT-012');

  it('carries all four fixture classes with the synthetic watermark', () => {
    expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
  });

  for (const fixtureClass of requiredFixtureClasses) {
    describe(fixtureClass, () => {
      const fixture = pack.fixtures[fixtureClass] as unknown as CapabilityFixture;
      it('declares at least one executable case', () => {
        expect(fixture.cases.length).toBeGreaterThan(0);
      });
      for (const fixtureCase of (pack.fixtures[fixtureClass] as unknown as CapabilityFixture)
        .cases) {
        it(fixtureCase.name, () => {
          runCase(fixture, fixtureCase);
        });
      }
    });
  }
});

describe('capability seed drift gate', () => {
  it('005-capability-seed.sql embeds exactly the generated section', () => {
    const seedSql = readFileSync(
      new URL('../../../infra/postgres/seed/005-capability-seed.sql', import.meta.url),
      'utf8',
    );
    const begin = seedSql.indexOf(capabilitySeedBeginMarker);
    const end = seedSql.indexOf(capabilitySeedEndMarker);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const embedded = seedSql.slice(begin, end + capabilitySeedEndMarker.length);
    expect(embedded).toBe(renderCapabilitySeedSection(registry, syntheticCapabilitySeedV1));
  });
});
