import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  extractBreachCaseSeedSection,
  renderBreachCaseSeedSection,
  syntheticBreachCaseSeedV1,
} from './seed-data.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('029-breach-case-seed.sql drift gate', () => {
  it('embeds exactly the generated synthetic seed section', () => {
    const committed = readFileSync(
      `${repoRoot}infra/postgres/seed/029-breach-case-seed.sql`,
      'utf8',
    );
    expect(extractBreachCaseSeedSection(committed)).toBe(renderBreachCaseSeedSection());
  });

  it('carries reconstructible reportable and opposite-tenant assessing postures', () => {
    const [northwind, riverbend] = syntheticBreachCaseSeedV1.aggregates;
    expect(northwind?.status).toBe('closed');
    expect(northwind?.geneticReviews[0]?.risk).toBe('critical');
    expect(northwind?.notices[0]?.state).toBe('delivered');
    expect(riverbend).toMatchObject({ tenantId: 'riverbend-synthetic', status: 'assessing' });
  });
});
