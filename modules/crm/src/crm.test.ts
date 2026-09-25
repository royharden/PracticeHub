import { describe, expect, it } from 'vitest';

import {
  advanceLead,
  CrmError,
  member360,
  mergeSilently,
  openIdentitySplit,
  openLead,
  projectDerivedFlag,
  writeDerivedFlagOntoIdentity,
} from './crm.js';
import type { MemberRecord } from './crm.js';

function record(): MemberRecord {
  return {
    personId: 'person-synthetic-1',
    preferredName: 'Member Synthetic',
    planTier: 'core',
    ageBand: '40-49',
    email: 'person-synthetic-1@example.test',
    householdId: 'household-synthetic-1',
    membershipAccountId: 'acct-synthetic-1',
    synthetic: true,
  };
}

describe('WP-070 CRM', () => {
  it('a derived flag cannot be written back onto the source identity', () => {
    const source = { personId: 'person-synthetic-1', status: 'provisional' };
    const before = JSON.stringify(source);
    const flag = projectDerivedFlag(source.personId);
    expect(flag).toEqual({ personId: 'person-synthetic-1', name: 'high-value', value: true });
    expect(() => writeDerivedFlagOntoIdentity(source.personId, flag)).toThrow(CrmError);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('member-360 returns only the fields in the purpose scope', () => {
    const view = member360(record(), 'marketing');
    expect(view).toEqual({ personId: 'person-synthetic-1', ageBand: '40-49' });
    expect(view).not.toHaveProperty('email');
    expect(view).not.toHaveProperty('householdId');
    expect(view).not.toHaveProperty('planTier');
  });

  it('an identity split keeps two person links and does not merge them silently', () => {
    const split = openIdentitySplit({
      splitId: 'split-1',
      tenantId: 'tenant-synthetic-a',
      leftPersonId: 'person-synthetic-1',
      rightPersonId: 'person-synthetic-2',
    });
    expect(() => mergeSilently(split)).toThrow(CrmError);
    expect(split.leftPersonId).toBe('person-synthetic-1');
    expect(split.rightPersonId).toBe('person-synthetic-2');
    const lead = advanceLead(
      openLead({
        leadId: 'lead-1',
        tenantId: 'tenant-synthetic-a',
        personId: split.leftPersonId,
      }),
      'qualified',
    );
    expect(lead.stage).toBe('qualified');
  });
});
