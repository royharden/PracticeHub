/**
 * Deceased flag + chart lock suites (WP-015; REQ-ID-021 lock half).
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  correctDeceasedFlag,
  deceasedFlagState,
  lockedSegmentsOnDeceased,
  setDeceasedFlag,
  suppressedOutreachChannels,
  unlockChartForEstate,
  type PersonFlagEvent,
} from './chart-lock.js';

const tenant = 'northwind-synthetic' as TenantId;
const person = 'np-riley-fox' as PersonId;

describe('deceased flag stream', () => {
  it('setting the flag emits the suppression + lock directives with zero grace sends (AC-1/AC-2)', () => {
    const { event, suppressionDirective, lockDirective } = setDeceasedFlag({
      tenantId: tenant,
      flagId: 'nfl-0001',
      personId: person,
      sourceRef: 'synthetic-death-report-0001',
      actorRef: 'synthetic-front-desk-001',
      occurredAt: '2026-03-18T09:30:00Z',
    });
    expect(event.action).toBe('set');
    expect(event.sourceRef).toBe('synthetic-death-report-0001');
    expect(suppressionDirective.cancelQueuedAcrossChannels).toEqual(suppressedOutreachChannels);
    expect(suppressionDirective.vendorSidePropagationRequired).toBe(true);
    expect(suppressionDirective.gracePeriodSends).toBe(0);
    expect(lockDirective.readOnly).toBe(true);
    expect(lockDirective.unlockRestrictedTo).toEqual([
      'compliance-privacy-officer',
      'practice-manager',
    ]);
    expect(lockedSegmentsOnDeceased).toEqual([
      'scheduling',
      'messaging',
      'medications',
      'clinical-notes',
    ]);
  });

  it('the flag-set event records who, when, and the confirmation source (AC-3)', () => {
    const events: PersonFlagEvent[] = [
      setDeceasedFlag({
        tenantId: tenant,
        flagId: 'nfl-0001',
        personId: person,
        sourceRef: 'synthetic-death-report-0001',
        actorRef: 'synthetic-front-desk-001',
        occurredAt: '2026-03-18T09:30:00Z',
      }).event,
    ];
    const state = deceasedFlagState(events, person);
    expect(state.deceased).toBe(true);
    expect(state.setBy).toBe('synthetic-front-desk-001');
    expect(state.sourceRef).toBe('synthetic-death-report-0001');
  });

  it('a set event without its confirmation source is unrepresentable', () => {
    expect(() =>
      deceasedFlagState(
        [
          {
            tenantId: tenant,
            flagId: 'nfl-bad',
            personId: person,
            kind: 'deceased',
            action: 'set',
            actorRef: 'synthetic-front-desk-001',
            occurredAt: '2026-03-18T09:30:00Z',
            synthetic: true,
          },
        ],
        person,
      ),
    ).toThrow('confirmation source');
  });

  it('correction requires DOCUMENTED evidence and restores prior state — no toggle-back (EX-1)', () => {
    const setEvent = setDeceasedFlag({
      tenantId: tenant,
      flagId: 'nfl-0001',
      personId: person,
      sourceRef: 'synthetic-death-report-0001',
      actorRef: 'synthetic-front-desk-001',
      occurredAt: '2026-03-18T09:30:00Z',
    }).event;
    expect(() =>
      correctDeceasedFlag([setEvent], {
        tenantId: tenant,
        flagId: 'nfl-0002',
        personId: person,
        correctionEvidenceRef: '',
        actorRef: 'synthetic-compliance-officer-001',
        occurredAt: '2026-03-20T09:30:00Z',
      }),
    ).toThrow();
    const { event, restoreDirective } = correctDeceasedFlag([setEvent], {
      tenantId: tenant,
      flagId: 'nfl-0002',
      personId: person,
      correctionEvidenceRef: 'synthetic-correction-evidence-0001',
      actorRef: 'synthetic-compliance-officer-001',
      occurredAt: '2026-03-20T09:30:00Z',
    });
    expect(restoreDirective.priorStateRestored).toBe(true);
    expect(restoreDirective.interimSilenceWasServiceFailure).toBe(false);
    const state = deceasedFlagState([setEvent, event], person);
    expect(state.deceased).toBe(false);
    expect(state.correctedBy).toBe('synthetic-compliance-officer-001');
  });

  it('correcting a person with no active flag refuses', () => {
    expect(() =>
      correctDeceasedFlag([], {
        tenantId: tenant,
        flagId: 'nfl-0003',
        personId: person,
        correctionEvidenceRef: 'synthetic-correction-evidence-0002',
        actorRef: 'synthetic-compliance-officer-001',
        occurredAt: '2026-03-20T09:30:00Z',
      }),
    ).toThrow('no active deceased flag');
  });
});

describe('estate unlock (AC-2)', () => {
  it('only the compliance-privacy-officer and practice-manager roles unlock, with a documented purpose', () => {
    expect(() =>
      unlockChartForEstate({
        unlockRef: 'neu-0001',
        personId: person,
        actorRoleKeys: ['front-desk'],
        documentedPurposeRef: 'synthetic-estate-purpose-0001',
      }),
    ).toThrow('restricted');
    expect(() =>
      unlockChartForEstate({
        unlockRef: 'neu-0001',
        personId: person,
        actorRoleKeys: ['practice-manager'],
        documentedPurposeRef: '',
      }),
    ).toThrow('documented estate/legal purpose');
    const unlock = unlockChartForEstate({
      unlockRef: 'neu-0001',
      personId: person,
      actorRoleKeys: ['practice-manager'],
      documentedPurposeRef: 'synthetic-estate-purpose-0001',
    });
    expect(unlock.unlockedByRole).toBe('practice-manager');
  });
});
