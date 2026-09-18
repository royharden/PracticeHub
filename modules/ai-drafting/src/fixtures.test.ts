import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  autoSend,
  decideQueue,
  draftArtifact,
  renderProvenance,
  restoreQuarantine,
} from './drafting.js';
import { binding, ports } from './test-support.js';
import { DraftingRefusal, type DraftKind } from './types.js';

const fixtureDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const requiredClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;

interface FixtureCase {
  readonly name: string;
  readonly op:
    | 'approve-send'
    | 'auto-send'
    | 'red-eval'
    | 'flag-off'
    | 'empty-provenance'
    | 'wrong-patient'
    | 'edit-requeue';
  readonly kind?: DraftKind;
}

interface Fixture {
  readonly synthetic: true;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function load(fixtureClass: string): Fixture {
  return JSON.parse(
    readFileSync(`${fixtureDirectory}/WP-102.${fixtureClass}.json`, 'utf8'),
  ) as Fixture;
}

describe('WP-102 four-class fixtures', () => {
  it.each(requiredClasses)('executes %s cases', (fixtureClass) => {
    const fixture = load(fixtureClass);
    expect(fixture.synthetic).toBe(true);
    expect(fixture.class).toBe(fixtureClass);
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const fixtureCase of fixture.cases) {
      const harness = ports(
        fixtureCase.op === 'wrong-patient'
          ? { subjectRef: 'sg-p-0099' }
          : fixtureCase.op === 'flag-off'
            ? { draftingSurfacesEnabled: false }
            : {},
      );
      if (fixtureCase.op === 'approve-send') {
        const draft = draftArtifact(harness, {
          draftId: `draft:${fixtureCase.name}`,
          kind: fixtureCase.kind ?? 'message',
          binding: binding({
            useCase: fixtureCase.kind === 'summary' ? 'previsit-brief' : 'inbox-reply',
          }),
          body: 'synthetic body',
          sourceRefs: ['src:1'],
        });
        expect(renderProvenance(draft.provenance)).toContain('evidence=');
        expect(decideQueue(harness, draft, 'approve', 'guide:1').state).toBe('sent');
        continue;
      }
      if (fixtureCase.op === 'auto-send') {
        const draft = draftArtifact(harness, {
          draftId: 'draft:auto',
          kind: 'message',
          binding: binding(),
          body: 'synthetic body',
          sourceRefs: ['src:1'],
        });
        expect(() => autoSend(draft)).toThrow(DraftingRefusal);
        continue;
      }
      if (fixtureCase.op === 'red-eval') {
        const draft = draftArtifact(harness, {
          draftId: 'draft:red',
          kind: 'summary',
          binding: binding({ useCase: 'previsit-brief' }),
          body: 'synthetic body',
          sourceRefs: ['src:1'],
          requiredMetricRed: true,
        });
        expect(() => decideQueue(harness, draft, 'approve', 'guide:1')).toThrow(DraftingRefusal);
        continue;
      }
      if (fixtureCase.op === 'flag-off') {
        expect(() =>
          draftArtifact(harness, {
            draftId: 'draft:off',
            kind: 'message',
            binding: binding(),
            body: 'synthetic body',
            sourceRefs: ['src:1'],
          }),
        ).toThrow(DraftingRefusal);
        continue;
      }
      if (fixtureCase.op === 'empty-provenance') {
        const draft = draftArtifact(harness, {
          draftId: 'draft:empty',
          kind: 'summary',
          binding: binding({ useCase: 'previsit-brief' }),
          body: 'synthetic body',
          sourceRefs: ['src:1'],
        });
        expect(() =>
          renderProvenance({ ...draft.provenance, sourceRefs: [], disclosureString: '' }),
        ).toThrow(DraftingRefusal);
        continue;
      }
      if (fixtureCase.op === 'wrong-patient') {
        const draft = draftArtifact(harness, {
          draftId: 'draft:wp',
          kind: 'message',
          binding: binding(),
          body: 'synthetic body',
          sourceRefs: ['src:1'],
        });
        expect(draft.state).toBe('quarantined');
        expect(restoreQuarantine(draft, binding().subjectRef).state).toBe('queued');
        continue;
      }
      if (fixtureCase.op === 'edit-requeue') {
        const draft = draftArtifact(harness, {
          draftId: 'draft:edit',
          kind: 'message',
          binding: binding(),
          body: 'synthetic body',
          sourceRefs: ['src:1'],
        });
        const edited = decideQueue(harness, draft, 'edit', 'guide:1', 'edited body');
        expect(edited.state).toBe('queued');
        expect(harness.thread.outbound).toEqual([]);
        continue;
      }
      throw new Error(`unknown fixture op ${fixtureCase.op}`);
    }
  });
});
