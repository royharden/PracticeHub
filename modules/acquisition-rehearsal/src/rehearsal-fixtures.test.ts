import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { boundedPanel, twentySyntheticSubjects } from './panel.js';
import { runAcquisitionRehearsal } from './rehearsal.js';
import { wp110ImportWorkbenchDoubleV1 } from './testing/wp110-import-double-v1.js';
import { wp114CutoverDoubleV1 } from './testing/wp114-cutover-double-v1.js';
import { RehearsalError } from './types.js';
import type { RehearsalSubject } from './types.js';

const directory = fileURLToPath(new URL('../fixtures', import.meta.url));

interface RehearsalFixtureCase {
  readonly name: string;
  readonly op: string;
  readonly expectOutcome?: string;
  readonly expectFrozen?: boolean;
  readonly expectRestored?: boolean;
  readonly expectRekeyed?: boolean;
  readonly expectError?: string;
  readonly expectWorkItem?: boolean;
}

const fixtureOps = [
  'twenty-twenty-post-freeze',
  'panel-not-twenty',
  'failed-cutover',
  'failed-cutover-restore',
  'rerun-after-fail',
  'non-synthetic',
  'duplicate-subjects',
] as const;

function okPanel() {
  return boundedPanel({
    tenantId: 'northwind-synthetic',
    panelId: 'panel-20',
    subjects: twentySyntheticSubjects(),
    synthetic: true,
  });
}

function runCase(fixtureCase: RehearsalFixtureCase): void {
  switch (fixtureCase.op) {
    case 'twenty-twenty-post-freeze':
    case 'rerun-after-fail': {
      const run = runAcquisitionRehearsal({
        panel: okPanel(),
        runId: 'run-ok',
        importer: wp110ImportWorkbenchDoubleV1(),
        cutover: wp114CutoverDoubleV1(false),
        synthetic: true,
      });
      expect(run.outcome).toBe(fixtureCase.expectOutcome ?? 'post-freeze-restored');
      expect(run.frozen).toBe(fixtureCase.expectFrozen ?? true);
      expect(run.restored).toBe(true);
      expect(run.rekeyed).toBe(true);
      return;
    }
    case 'panel-not-twenty': {
      expect(() =>
        boundedPanel({
          tenantId: 't1',
          panelId: 'p1',
          subjects: twentySyntheticSubjects().slice(0, 19),
          synthetic: true,
        }),
      ).toThrow(fixtureCase.expectError);
      return;
    }
    case 'failed-cutover':
    case 'failed-cutover-restore': {
      const run = runAcquisitionRehearsal({
        panel: okPanel(),
        runId: 'run-fail',
        importer: wp110ImportWorkbenchDoubleV1(),
        cutover: wp114CutoverDoubleV1(true),
        synthetic: true,
      });
      expect(run.outcome).toBe('failed-cutover');
      expect(run.frozen).toBe(false);
      if (fixtureCase.expectRestored !== undefined) {
        expect(run.restored).toBe(fixtureCase.expectRestored);
      }
      if (fixtureCase.expectRekeyed !== undefined) {
        expect(run.rekeyed).toBe(fixtureCase.expectRekeyed);
      }
      if (fixtureCase.expectWorkItem === true) {
        expect(run.workItemId).toBe('wi:rehearsal-fail:run-fail');
      }
      return;
    }
    case 'non-synthetic': {
      expect(() =>
        boundedPanel({
          tenantId: 't1',
          panelId: 'p1',
          subjects: twentySyntheticSubjects(),
          synthetic: false,
        }),
      ).toThrow(fixtureCase.expectError);
      return;
    }
    case 'duplicate-subjects': {
      const subjects: RehearsalSubject[] = twentySyntheticSubjects().map((subject, index) =>
        index === 19 ? { subjectRef: 'acq-01', synthetic: true as const } : subject,
      );
      expect(() =>
        boundedPanel({
          tenantId: 't1',
          panelId: 'p1',
          subjects,
          synthetic: true,
        }),
      ).toThrow(fixtureCase.expectError);
      return;
    }
    default:
      throw new RehearsalError(`unknown op ${fixtureCase.op}`);
  }
}

for (const requirementId of ['REQ-MIG-018', 'REQ-MIG-019']) {
  describe(`${requirementId} fixture pack`, () => {
    const pack = loadRequirementFixturePack(directory, requirementId);
    it('carries the complete four-class floor and a closed operation vocabulary', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as { cases: readonly RehearsalFixtureCase[] };
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(fixtureOps).toContain(fixtureCase.op);
        }
      }
    });
    for (const fixtureClass of requiredFixtureClasses) {
      const fixture = pack.fixtures[fixtureClass] as { cases: readonly RehearsalFixtureCase[] };
      for (const fixtureCase of fixture.cases) {
        it(`${fixtureClass}: ${fixtureCase.name}`, () => {
          runCase(fixtureCase);
        });
      }
    }
  });
}
