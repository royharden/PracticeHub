import { describe, expect, it } from 'vitest';

import { MedListError, MedicationList } from './med-list.js';

describe('MedicationList single ownership', () => {
  it('lets the claimed owner add and remove items', () => {
    const list = new MedicationList('northwind-synthetic', 'person-1');
    list.claimOwner('clinician-assigned');
    list.add('med-1', 'synthetic-display', 'clinician-assigned');
    expect(list.list()).toHaveLength(1);
    list.remove('med-1', 'clinician-assigned');
    expect(list.list()).toHaveLength(0);
  });

  it('refuses a second owner and non-owner writes', () => {
    const list = new MedicationList('northwind-synthetic', 'person-1');
    list.claimOwner('clinician-assigned');
    expect(() => list.claimOwner('other-clinician')).toThrow(MedListError);
    expect(() => list.add('med-1', 'x', 'other-clinician')).toThrow(/single owner/);
  });
});
