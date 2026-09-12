import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  capabilityDefinitionsV1,
  capabilityRegistryV1,
  capabilitySeedBeginMarker,
  capabilitySeedEndMarker,
  renderCapabilitySeedSection,
  syntheticCapabilitySeedV1,
} from './capability-definitions.js';
import {
  applyCapabilityTransition,
  applyEventToGrants,
  foldCapabilityEvents,
  requireCapability,
  type CapabilityGrant,
  type CapabilityScope,
} from './capability.js';

const scope = { feature: 'draft-visit-summary', cohort: 'cohort-alpha' } as const;
const grants = foldCapabilityEvents(
  capabilityRegistryV1,
  syntheticCapabilitySeedV1.initialGrants,
  syntheticCapabilitySeedV1.events,
);
const aiGrants = grants.filter((grant) => grant.capabilityId === 'ai.gateway');

describe('exact synthetic AI capability data', () => {
  it('requires both feature and cohort and seeds only the two exact tenant scopes', () => {
    expect(
      capabilityDefinitionsV1.filter((definition) => definition.capabilityId === 'ai.gateway'),
    ).toEqual([
      expect.objectContaining({
        ownerRole: 'security',
        dimensions: ['feature', 'cohort'],
        requiredDimensions: ['feature', 'cohort'],
        precedence: ['feature', 'cohort'],
      }),
    ]);
    expect(
      aiGrants
        .map(({ tenantId, scope: grantScope, state }) => ({ tenantId, scope: grantScope, state }))
        .sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
    ).toEqual([
      { tenantId: 'northwind-synthetic', scope, state: 'simulated' },
      { tenantId: 'riverbend-synthetic', scope, state: 'disabled' },
    ]);
    const events = syntheticCapabilitySeedV1.events.filter(
      (event) => event.capabilityId === 'ai.gateway',
    );
    expect(
      events.map(({ tenantId, scope: eventScope, fromState, toState }) => ({
        tenantId,
        scope: eventScope,
        fromState,
        toState,
      })),
    ).toEqual([
      { tenantId: 'northwind-synthetic', scope, fromState: 'disabled', toState: 'scaffolded' },
      { tenantId: 'northwind-synthetic', scope, fromState: 'scaffolded', toState: 'simulated' },
    ]);
    expect(
      aiGrants.find((grant) => grant.tenantId === 'riverbend-synthetic')?.sinceEventId,
    ).toBeNull();
  });

  it('permits the synthetic inference floor at enqueue and drain, never the default pilot floor', () => {
    for (const checkpoint of ['enqueue', 'drain'] as const) {
      expect(
        requireCapability(
          capabilityRegistryV1,
          grants,
          { tenantId: 'northwind-synthetic', scope },
          'ai.gateway',
          { minimumState: 'simulated', checkpoint },
        ).allowed,
      ).toBe(true);
    }
    expect(() =>
      requireCapability(
        capabilityRegistryV1,
        grants,
        { tenantId: 'northwind-synthetic', scope },
        'ai.gateway',
      ),
    ).toThrow();
  });

  it.each([
    ['riverbend-synthetic', scope],
    ['northwind-synthetic', { feature: 'other-feature', cohort: 'cohort-alpha' }],
    ['northwind-synthetic', { feature: 'draft-visit-summary', cohort: 'cohort-beta' }],
    ['northwind-synthetic', {}],
  ] as const)('refuses unseeded or disabled tenant/scope %s %j', (tenantId, requestedScope) => {
    expect(() =>
      requireCapability(
        capabilityRegistryV1,
        grants,
        { tenantId, scope: requestedScope },
        'ai.gateway',
        { minimumState: 'simulated' },
      ),
    ).toThrow();
  });

  it.each<CapabilityScope>([{}, { feature: 'draft-visit-summary' }, { cohort: 'cohort-alpha' }])(
    'refuses a broadened grant missing required dimensions: %j',
    (grantScope) => {
      const broad: CapabilityGrant = {
        capabilityId: 'ai.gateway',
        tenantId: 'northwind-synthetic',
        scope: grantScope,
        state: 'simulated',
        sinceEventId: 'synthetic-ai-broad',
        evidenceRefs: [],
        rollbackRef: 'registry-event-replay',
        synthetic: true,
      };
      expect(() =>
        requireCapability(
          capabilityRegistryV1,
          [broad],
          { tenantId: 'northwind-synthetic', scope },
          'ai.gateway',
          { minimumState: 'simulated' },
        ),
      ).toThrow(/requires dimension (feature|cohort) on every grant/);
    },
  );

  it('allows protective lowering with no approval/evidence and then denies inference', () => {
    const event = applyCapabilityTransition(
      capabilityRegistryV1,
      grants,
      {
        capabilityId: 'ai.gateway',
        tenantId: 'northwind-synthetic',
        scope,
        fromState: 'simulated',
        toState: 'scaffolded',
        initiatorRef: 'synthetic-security-owner',
        approvals: [],
        evidenceRefs: [],
        reason: 'synthetic protective lowering',
      },
      'synthetic-ai-lowered',
    );
    const lowered = applyEventToGrants(grants, event);
    expect(() =>
      requireCapability(
        capabilityRegistryV1,
        lowered,
        { tenantId: 'northwind-synthetic', scope },
        'ai.gateway',
        { minimumState: 'simulated' },
      ),
    ).toThrow();
  });

  it('keeps the SQL projection byte-faithful to the event renderer', () => {
    const sql = readFileSync(
      new URL('../../../infra/postgres/seed/005-capability-seed.sql', import.meta.url),
      'utf8',
    );
    const begin = sql.indexOf(capabilitySeedBeginMarker);
    const end = sql.indexOf(capabilitySeedEndMarker);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    expect(sql.slice(begin, end + capabilitySeedEndMarker.length)).toBe(
      renderCapabilitySeedSection(capabilityRegistryV1, syntheticCapabilitySeedV1),
    );
  });
});

describe('AI seed static scope checks (database execution remains required)', () => {
  const sql = readFileSync(
    new URL('../../../infra/postgres/seed/024-ai-gateway-seed.sql', import.meta.url),
    'utf8',
  );
  const inserts = [
    ...sql.matchAll(
      /INSERT INTO (ai_gateway\.\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*ON CONFLICT/g,
    ),
  ];
  const rows = new Map(
    inserts.map((match) => {
      const columns = (match[2] ?? '').split(',').map((value) => value.trim());
      const values = (match[3] ?? '').split(',').map((value) => value.trim());
      expect(values.length).toBe(columns.length);
      return [
        match[1],
        Object.fromEntries(columns.map((column, index) => [column, values[index]])),
      ];
    }),
  );

  it('contains exactly one dev-only covered binding with the D1 fixture versions and refs', () => {
    expect(inserts).toHaveLength(2);
    expect(rows.get('ai_gateway.model_binding')).toEqual({
      tenant_id: "'northwind-synthetic'",
      use_case: "'draft-visit-summary'",
      cohort_ref: "'cohort-alpha'",
      binding_ref: "'binding:summary:alpha'",
      vendor_id: "'synthetic-ai-covered'",
      model_ref: "'model:synthetic-summary'",
      pinned_model_version: "'model-api-v1'",
      prompt_template_version: "'prompt-v1'",
      system_policy_ref: "'policy:ai:v1'",
      version: '1',
      mode: "'dev'",
      enabled: 'true',
      synthetic: 'true',
    });
  });

  it('contains one exact subject/purpose grant with human approval and no side effect', () => {
    expect(rows.get('ai_gateway.tool_grant')).toEqual({
      tenant_id: "'northwind-synthetic'",
      actor_ref: "'staff:northwind:001'",
      subject_ref: "'subject:northwind:001'",
      cohort_ref: "'cohort-alpha'",
      ai_system_ref: "'ai:summary'",
      purpose: "'treatment'",
      version: '1',
      allowed_tool_ids: "ARRAY['tool:chart-read']::text[]",
      allowed_argument_keys_by_tool: `'${JSON.stringify({ 'tool:chart-read': ['subjectRef'] })}'::jsonb`,
      required_argument_keys_by_tool: `'${JSON.stringify({ 'tool:chart-read': ['subjectRef'] })}'::jsonb`,
      allow_draft_side_effect: 'false',
      human_approval_required: 'true',
      enabled: 'true',
      environment: "'dev'",
      synthetic: 'true',
    });
    expect(sql).not.toMatch(/INSERT INTO ai_gateway\.(?:interaction|cohort_containment)/);
    expect(sql).not.toMatch(/DO UPDATE|\bDELETE\b/);
    expect(sql.match(/DO NOTHING/g)).toHaveLength(2);
    expect(sql).toContain("WHERE tenant_id = 'riverbend-synthetic' AND enabled");
    expect(sql).toContain("FROM ai_gateway.tool_grant WHERE tenant_id = 'riverbend-synthetic'");
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });
});
