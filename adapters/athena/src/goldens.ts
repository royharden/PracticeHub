import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

export interface AthenaGolden {
  readonly name: string;
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly payloadHash: string;
  readonly synthetic: true;
}

export function loadGolden(name: string): AthenaGolden {
  const raw = JSON.parse(
    readFileSync(resolve(directory, `../goldens/${name}.json`), 'utf8'),
  ) as AthenaGolden;
  if (raw.synthetic !== true || raw.name !== name) {
    throw new Error(`WP061_GOLDEN_INVALID:${name}`);
  }
  return raw;
}
