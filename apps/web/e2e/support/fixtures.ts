import { readFileSync } from 'node:fs';

import type {
  ContractFixture,
  ContractKey,
  FixtureClass,
  FixturePack,
} from '../contracts/v1/types.js';
import { fixtureClasses } from '../contracts/v1/types.js';
import { assertCorpusReference, type SynthCorpus } from './corpus.js';

const contractKeys: readonly ContractKey[] = ['wp030', 'wp031', 'wp032'];

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = new URL('../fixtures/WP-035.' + fixtureClass + '.json', import.meta.url);
  const value = JSON.parse(readFileSync(path, 'utf8')) as FixturePack;
  if (
    value.synthetic !== true ||
    value.fixtureClass !== fixtureClass ||
    value.simulatedClock !== '2026-01-01T00:00:00Z'
  ) {
    throw new Error('invalid WP-035 fixture identity: ' + fixtureClass);
  }
  for (const key of contractKeys) {
    const fixture = value.contracts[key];
    if (!fixture) {
      throw new Error('fixture ' + fixtureClass + ' lacks contract ' + key);
    }
    if (
      fixture.operationKey.length === 0 ||
      fixture.actionNote.length === 0 ||
      !['success', 'failure', 'recoverable'].includes(fixture.apiOutcome) ||
      fixture.expectedEffectCount < 0
    ) {
      throw new Error('fixture ' + fixtureClass + ' has invalid semantics for ' + key);
    }
  }
  return value;
}

export function loadFixturePacks(corpus: SynthCorpus): ReadonlyMap<FixtureClass, FixturePack> {
  const packs = new Map<FixtureClass, FixturePack>();
  for (const fixtureClass of fixtureClasses) {
    const pack = loadPack(fixtureClass);
    for (const key of contractKeys) {
      assertCorpusReference(corpus, pack.contracts[key].reference);
    }
    packs.set(fixtureClass, pack);
  }
  if (packs.size !== fixtureClasses.length) {
    throw new Error('WP-035 fixture floor is incomplete');
  }
  return packs;
}

export function contractFixture(pack: FixturePack, key: ContractKey): ContractFixture {
  return { fixtureClass: pack.fixtureClass, ...pack.contracts[key] };
}
