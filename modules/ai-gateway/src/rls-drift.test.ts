import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { aiGatewayRlsSpecs, aiGatewaySchemaRlsSpecs } from './rls-specs.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('0023-ai-gateway.sql RLS drift gate', () => {
  it('embeds exactly the generated tenant-isolation section', () => {
    const migration = readFileSync(
      `${repoRoot}modules/ai-gateway/migrations/0023-ai-gateway.sql`,
      'utf8',
    );
    expect(extractRlsMigrationSection(migration)).toBe(
      renderRlsMigrationSection('ai_gateway', aiGatewayRlsSpecs, aiGatewaySchemaRlsSpecs),
    );
  });
});
