import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  acceptedFaxFixtureOps,
  runFaxFixtureCase,
  type FaxFixtureCase,
} from './fax-fixture-harness.js';
import type { FaxUrgentWorkDescriptor } from './fax-routing.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const packs = ['REQ-DOC-001', 'REQ-DOC-009', 'FAX-RT20', 'REQ-DOC-011-AC4-EX2'];

interface FaxFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FaxFixtureCase[];
}

for (const requirementId of packs) {
  describe(`${requirementId} fax fixture pack`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with recognized operations', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as FaxFixture;
        expect(fixture.synthetic).toBe(true);
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect((acceptedFaxFixtureOps as readonly string[]).includes(fixtureCase.op)).toBe(true);
        }
      }
    });

    for (const fixtureClass of requiredFixtureClasses) {
      const fixture = pack.fixtures[fixtureClass] as unknown as FaxFixture;
      for (const fixtureCase of fixture.cases) {
        it(`${fixtureClass}: ${fixtureCase.name}`, async () => {
          if (fixtureCase.expectedError !== undefined) {
            await expect(runFaxFixtureCase(fixtureCase)).rejects.toThrow(fixtureCase.expectedError);
            return;
          }
          const result = await runFaxFixtureCase(fixtureCase);
          if (fixtureCase.op === 'route') {
            const routed = result as {
              groups: readonly { kind: string; reason?: string }[];
              urgentWork: unknown;
            };
            expect(routed.groups.map((group) => group.kind)).toEqual(fixtureCase.expectedKinds);
            if (fixtureCase.expectedReasons !== undefined) {
              expect(routed.groups.map((group) => group.reason)).toEqual(
                fixtureCase.expectedReasons,
              );
            }
            expect(routed.urgentWork !== null).toBe(fixtureCase.expectedUrgent ?? false);
          } else if (fixtureCase.op === 'confirm') {
            expect((result as { filings: readonly unknown[] }).filings).toHaveLength(
              fixtureCase.expectedFilings ?? 0,
            );
          } else if (fixtureCase.op === 'urgent-sweep') {
            expect(
              (result as readonly FaxUrgentWorkDescriptor[]).map((item) => item.documentId),
            ).toEqual(fixtureCase.expectedSweep);
          } else if (fixtureCase.op === 'sender-pattern') {
            expect(result).toMatchObject({
              flagPracticeManagerOutreach: fixtureCase.expectedOutreach,
              perFaxMinimumConfidence: 0.9,
              matchPolicyUnchanged: true,
            });
          }
        });
      }
    }
  });
}
