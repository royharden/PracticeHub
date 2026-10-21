import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CrmError,
  DerivedFlagProjection,
  linkSplitToMergeCase,
  member360ForCaller,
  openGovernedIdentitySplit,
  openLeadForIdentity,
  RecordingIdentityPort,
  resolveIdentitySplit,
  StaticMember360Pdp,
  type CrmCaller,
  type IdentityReadPort,
  type MemberRecord,
  type Wp016MergeCasePort,
} from './index.js';

const tenantA = 'tenant-synthetic-a';
const tenantB = 'tenant-synthetic-b';

function record(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    personId: 'person-synthetic-1',
    preferredName: 'Member Synthetic',
    planTier: 'core',
    ageBand: '40-49',
    email: 'person-synthetic-1@example.test',
    householdId: 'household-synthetic-1',
    membershipAccountId: 'acct-synthetic-1',
    tenantId: tenantA,
    synthetic: true,
    ...overrides,
  };
}

const pdp = () =>
  new StaticMember360Pdp({
    marketer: { marketing: ['ageBand'] },
    scheduler: { scheduling: ['preferredName'] },
    'billing-clerk': { billing: ['planTier'] },
  });

const caller = (roles: readonly string[], tenantId = tenantA): CrmCaller => ({
  actorId: 'staff-synthetic-1',
  tenantId,
  roles,
});

function identity(): RecordingIdentityPort {
  const port = new RecordingIdentityPort();
  for (const [tenantId, personId] of [
    [tenantA, 'person-synthetic-1'],
    [tenantA, 'person-synthetic-2'],
    [tenantB, 'person-synthetic-9'],
  ] as const) {
    port.seed({ tenantId, personId, status: 'active', attributes: { givenName: 'Synthetic' } });
  }
  return port;
}

describe('WP-070 rework F1: member-360 tenancy and PDP scoping', () => {
  it('returns only the fields the PDP grants within the purpose scope', () => {
    const decider = pdp();
    const view = member360ForCaller({
      tenantId: tenantA,
      caller: caller(['billing-clerk']),
      purpose: 'billing',
      record: record(),
      pdp: decider,
    });
    expect(view.fields).toEqual({ planTier: 'core' });
    expect(view.fields).not.toHaveProperty('membershipAccountId');
    expect(decider.decisions).toHaveLength(1);
  });

  it('refuses a record from another tenant, a caller from another tenant, and an untenanted record', () => {
    const run = (overrides: {
      tenantId?: string;
      callerTenant?: string;
      recordTenant?: string | null;
    }) =>
      member360ForCaller({
        tenantId: overrides.tenantId ?? tenantA,
        caller: caller(['marketer'], overrides.callerTenant ?? tenantA),
        purpose: 'marketing',
        record:
          overrides.recordTenant === null
            ? { ...record(), tenantId: undefined as never }
            : record({ tenantId: overrides.recordTenant ?? tenantA }),
        pdp: pdp(),
      });
    expect(() => run({ recordTenant: tenantB })).toThrow(
      expect.objectContaining({ code: 'CRM_TENANT' }),
    );
    expect(() => run({ callerTenant: tenantB })).toThrow(
      expect.objectContaining({ code: 'CRM_TENANT' }),
    );
    expect(() => run({ recordTenant: null })).toThrow(
      expect.objectContaining({ code: 'CRM_TENANT' }),
    );
    expect(run({}).fields).toEqual({ ageBand: '40-49' });
  });

  it('refuses a purpose the PDP does not grant to the caller', () => {
    expect(() =>
      member360ForCaller({
        tenantId: tenantA,
        caller: caller(['marketer']),
        purpose: 'billing',
        record: record(),
        pdp: pdp(),
      }),
    ).toThrow(expect.objectContaining({ code: 'CRM_PDP_DENY' }));
  });

  it('a PDP grant cannot widen a purpose beyond its allowlist', () => {
    const wide = new StaticMember360Pdp({
      marketer: { marketing: ['ageBand', 'email', 'householdId'] },
    });
    const view = member360ForCaller({
      tenantId: tenantA,
      caller: caller(['marketer']),
      purpose: 'marketing',
      record: record(),
      pdp: wide,
    });
    expect(view.fields).toEqual({ ageBand: '40-49' });
  });
});

describe('WP-070 rework F2: derived flags travel one way', () => {
  it('projects a flag from real inputs without ever calling the identity write path', () => {
    const port = identity();
    const before = port.read(tenantA, 'person-synthetic-1');
    const projection = new DerivedFlagProjection(port, 500_000);
    expect(
      projection.project({
        tenantId: tenantA,
        personId: 'person-synthetic-1',
        lifetimeValueMinor: 750_000,
      }),
    ).toMatchObject({
      name: 'high-value',
      value: true,
      tenantId: tenantA,
    });
    expect(
      projection.project({
        tenantId: tenantA,
        personId: 'person-synthetic-2',
        lifetimeValueMinor: 10_000,
      }),
    ).toBeNull();
    expect(projection.get(tenantA, 'person-synthetic-2')).toBeUndefined();
    expect(port.writeCalls).toBe(0);
    expect(port.read(tenantA, 'person-synthetic-1')).toEqual(before);
  });

  it('the identity port CRM receives has no write method', () => {
    expectTypeOf<keyof IdentityReadPort>().toEqualTypeOf<'read'>();
    const port = identity();
    const projection = new DerivedFlagProjection(port, 1);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(projection))).not.toContain(
      'updateAttributes',
    );
  });

  it('refuses to project for a person who is not an identity of that tenant', () => {
    const projection = new DerivedFlagProjection(identity(), 1);
    expect(() =>
      projection.project({
        tenantId: tenantB,
        personId: 'person-synthetic-1',
        lifetimeValueMinor: 5,
      }),
    ).toThrow(CrmError);
  });
});

describe('WP-070 rework F3 and tenancy of links: governed identity split', () => {
  const cases = (
    status: 'open' | 'resolved-distinct' | 'resolved-merged',
    tenantId = tenantA,
  ): Wp016MergeCasePort => ({
    get: (tenant, caseId) =>
      tenant === tenantId && caseId === 'case-1'
        ? { caseId, tenantId, status, personIds: ['person-synthetic-1', 'person-synthetic-2'] }
        : undefined,
  });
  const input = {
    splitId: 'split-1',
    tenantId: tenantA,
    leftPersonId: 'person-synthetic-1',
    rightPersonId: 'person-synthetic-2',
  };

  it('opens only when both persons are identities of the split tenant', () => {
    expect(openGovernedIdentitySplit(input, identity()).status).toBe('open');
    expect(() =>
      openGovernedIdentitySplit({ ...input, rightPersonId: 'person-synthetic-9' }, identity()),
    ).toThrow(expect.objectContaining({ code: 'CRM_TENANT' }));
    expect(() =>
      openLeadForIdentity(
        { leadId: 'lead-9', tenantId: tenantA, personId: 'person-synthetic-9' },
        identity(),
      ),
    ).toThrow(expect.objectContaining({ code: 'CRM_TENANT' }));
  });

  it('resolves only through its linked merge case', () => {
    const split = openGovernedIdentitySplit(input, identity());
    expect(() => resolveIdentitySplit(split, cases('resolved-distinct'), 'staff-1')).toThrow(
      expect.objectContaining({ code: 'CRM_SILENT_MERGE' }),
    );
    const linked = linkSplitToMergeCase(split, 'case-1', cases('open'));
    expect(() => resolveIdentitySplit(linked, cases('open'), 'staff-1')).toThrow(/stays open/);
    expect(resolveIdentitySplit(linked, cases('resolved-distinct'), 'staff-1').status).toBe(
      'resolved-distinct',
    );
    expect(resolveIdentitySplit(linked, cases('resolved-merged'), 'staff-1').status).toBe(
      'resolved-merged',
    );
  });

  it('refuses a merge case from another tenant or one that does not cover both persons', () => {
    const split = openGovernedIdentitySplit(input, identity());
    expect(() => linkSplitToMergeCase(split, 'case-1', cases('open', tenantB))).toThrow(CrmError);
    expect(() => linkSplitToMergeCase(split, 'case-missing', cases('open'))).toThrow(CrmError);
  });
});
