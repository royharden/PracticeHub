import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RecordingCutover, RecordingWorkbench } from './doubles.js';
import { rehearse, rewriteWorkbench } from './rehearse.js';
import { RehearsalRefusal, type LeftoverReq } from './types.js';

const fixtureDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const requiredClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;

interface FixtureCase {
  readonly name: string;
  readonly op: 'encode' | 'refused-workbench' | 'rewrite' | 'frozen-rerun';
  readonly req?: LeftoverReq;
}

function load(fixtureClass: string): {
  readonly class: string;
  readonly cases: readonly FixtureCase[];
} {
  return JSON.parse(readFileSync(`${fixtureDirectory}/WP-129.${fixtureClass}.json`, 'utf8')) as {
    readonly class: string;
    readonly cases: readonly FixtureCase[];
  };
}

describe('WP-129 four-class fixtures', () => {
  it.each(requiredClasses)('executes %s cases', (fixtureClass) => {
    const fixture = load(fixtureClass);
    expect(fixture.class).toBe(fixtureClass);
    for (const fixtureCase of fixture.cases) {
      if (fixtureCase.op === 'encode') {
        const ports = { workbench: new RecordingWorkbench(), cutover: new RecordingCutover() };
        expect(rehearse(ports, fixtureCase.req ?? 'REQ-MIG-001').synthetic).toBe(true);
        continue;
      }
      if (fixtureCase.op === 'refused-workbench') {
        expect(() =>
          rehearse(
            { workbench: new RecordingWorkbench(false), cutover: new RecordingCutover() },
            'REQ-MIG-007',
          ),
        ).toThrow(RehearsalRefusal);
        continue;
      }
      if (fixtureCase.op === 'rewrite') {
        expect(() => rewriteWorkbench()).toThrow(RehearsalRefusal);
        continue;
      }
      if (fixtureCase.op === 'frozen-rerun') {
        expect(() =>
          rehearse(
            { workbench: new RecordingWorkbench(), cutover: new RecordingCutover(true) },
            'REQ-MIG-019',
          ),
        ).toThrow(RehearsalRefusal);
        continue;
      }
      throw new Error(`unknown fixture op ${(fixtureCase as FixtureCase).op}`);
    }
  });
});
