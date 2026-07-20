import { fileURLToPath } from 'node:url';

import type { TenancyContext } from '@practicehub/contracts';
import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import type { AcceptancePolicyDecision, ConfigEntry } from './config-registry.js';
import {
  assertConfigEntryWritable,
  ConfigRegistryError,
  lookupAcceptingNewPatients,
  resolveConfig,
} from './config-registry.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

interface LookupCase {
  readonly name: string;
  readonly entryIndexes?: readonly number[];
  readonly context: TenancyContext;
  readonly payerId: string;
  readonly providerId: string;
  readonly expect?: AcceptancePolicyDecision;
  readonly expectError?: string;
  readonly expectRetainedRevisions?: number;
  readonly expectRevisionAttribution?: readonly {
    readonly revision: number;
    readonly changedBy: string;
  }[];
}

interface WriteCase {
  readonly name: string;
  readonly entryIndex?: number;
  readonly entry?: ConfigEntry;
  readonly expectError?: string;
}

interface AcceptanceFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly entries: readonly ConfigEntry[];
  readonly cases?: readonly LookupCase[];
  readonly writeCases?: readonly WriteCase[];
}

function loadPack(requirementId: string): ReadonlyMap<string, AcceptanceFixture> {
  const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);
  return new Map(
    Object.entries(pack.fixtures).map(([fixtureClass, fixture]) => [
      fixtureClass,
      fixture as AcceptanceFixture,
    ]),
  );
}

function runFixtureCases(requirementId: string): void {
  const fixtures = loadPack(requirementId);
  for (const fixtureClass of requiredFixtureClasses) {
    const fixture = fixtures.get(fixtureClass);
    if (fixture === undefined) {
      throw new Error(`${requirementId} fixture pack is missing ${fixtureClass}`);
    }
    describe(`${requirementId} ${fixtureClass}`, () => {
      for (const writeCase of fixture.writeCases ?? []) {
        it(writeCase.name, () => {
          const entry = writeCase.entry ?? fixture.entries[writeCase.entryIndex ?? 0];
          if (entry === undefined) {
            throw new Error(`write case ${writeCase.name} names no entry`);
          }
          if (writeCase.expectError !== undefined) {
            expect(() => assertConfigEntryWritable(entry)).toThrow(
              new RegExp(writeCase.expectError),
            );
          } else {
            expect(() => assertConfigEntryWritable(entry)).not.toThrow();
          }
        });
      }
      for (const lookupCase of fixture.cases ?? []) {
        it(lookupCase.name, () => {
          const entries =
            lookupCase.entryIndexes?.map((index) => {
              const entry = fixture.entries[index];
              if (entry === undefined) {
                throw new Error(`case ${lookupCase.name} references missing entry ${index}`);
              }
              return entry;
            }) ?? fixture.entries;
          if (lookupCase.expectError !== undefined) {
            expect(() =>
              lookupAcceptingNewPatients(
                entries,
                lookupCase.context,
                lookupCase.payerId,
                lookupCase.providerId,
              ),
            ).toThrow(new RegExp(lookupCase.expectError));
            return;
          }
          const decision = lookupAcceptingNewPatients(
            entries,
            lookupCase.context,
            lookupCase.payerId,
            lookupCase.providerId,
          );
          expect(decision).toEqual(lookupCase.expect);
          if (lookupCase.expectRetainedRevisions !== undefined) {
            const matched = entries.filter((entry) => entry.key === lookupCase.expect?.matchedKey);
            expect(matched).toHaveLength(lookupCase.expectRetainedRevisions);
          }
          for (const attribution of lookupCase.expectRevisionAttribution ?? []) {
            const revisionEntry = entries.find(
              (entry) =>
                entry.key === lookupCase.expect?.matchedKey &&
                entry.revision === attribution.revision,
            );
            expect(
              revisionEntry?.changedBy,
              `revision ${attribution.revision} must retain its actor attribution`,
            ).toBe(attribution.changedBy);
          }
        });
      }
    });
  }
}

runFixtureCases('REQ-ADM-027');
runFixtureCases('REQ-ADM-047');

describe('config registry isolation and fail-closed writes', () => {
  const northwindContext = {
    tenantId: 'northwind-synthetic',
    legalEntityId: 'shared-entity-id',
    locationId: 'shared-location-id',
  } as TenancyContext;

  const riverbendEntry = {
    tenantId: 'riverbend-synthetic',
    legalEntityId: 'shared-entity-id',
    locationId: 'shared-location-id',
    namespace: 'branding',
    key: 'display-name',
    value: 'Riverbend Health (Synthetic)',
    phiClass: 'none',
    counselOwned: false,
    revision: 1,
    changedBy: 'synthetic-test-actor-001',
  } as unknown as ConfigEntry;

  const northwindEntry = {
    tenantId: 'northwind-synthetic',
    namespace: 'branding',
    key: 'display-name',
    value: 'Northwind Health & Care (Synthetic)',
    phiClass: 'none',
    counselOwned: false,
    revision: 1,
    changedBy: 'synthetic-test-actor-001',
  } as unknown as ConfigEntry;

  it("T-09a: resolution never returns another tenant's entry, even a more specific one", () => {
    const resolved = resolveConfig(
      [riverbendEntry, northwindEntry],
      northwindContext,
      'branding',
      'display-name',
    );
    expect(resolved).toBe(northwindEntry);
    const riverbendOnly = resolveConfig(
      [riverbendEntry],
      northwindContext,
      'branding',
      'display-name',
    );
    expect(riverbendOnly).toBeUndefined();
  });

  it('T-10a: a write above the config PHI ceiling fails closed', () => {
    expect(() =>
      assertConfigEntryWritable({ ...northwindEntry, phiClass: 'PHI' } as unknown as ConfigEntry),
    ).toThrow(/exceeds the config ceiling/);
  });

  it('T-11a: a counsel-owned write without change control fails closed (R6-SR-110)', () => {
    expect(() =>
      assertConfigEntryWritable({ ...northwindEntry, counselOwned: true } as ConfigEntry),
    ).toThrow(/change-control/);
    expect(() =>
      assertConfigEntryWritable({
        ...northwindEntry,
        counselOwned: true,
        changeControlRef: 'synthetic-ccr-001',
      } as ConfigEntry),
    ).not.toThrow();
  });

  it('rejects unknown namespaces and non-positive revisions', () => {
    expect(() =>
      assertConfigEntryWritable({
        ...northwindEntry,
        namespace: 'not-a-namespace',
      } as unknown as ConfigEntry),
    ).toThrow(ConfigRegistryError);
    expect(() =>
      assertConfigEntryWritable({ ...northwindEntry, revision: 0 } as ConfigEntry),
    ).toThrow(/positive integer revision/);
  });
});
