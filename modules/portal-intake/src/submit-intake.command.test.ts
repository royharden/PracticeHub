import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  InMemoryIntakeAttemptStore,
  InMemoryIntakeRecordStore,
  RecordingUploadDouble,
  RecordingWorkItemDouble,
} from './contract-doubles.js';
import { submitIntakeCommand } from './commands/submit-intake.command.js';
import { syntheticSubmission } from './intake.test.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];
const grant = (
  state: CapabilityGrant['state'],
  tenantId = 'northwind-synthetic',
): CapabilityGrant => ({
  capabilityId: 'portal.intake',
  tenantId,
  scope: {},
  state,
  sinceEventId: null,
  evidenceRefs: ['synthetic-evidence:portal-intake'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
});

describe('portal intake capability gate', () => {
  it('allows simulated Northwind submission and returns an AuthorityDecision', async () => {
    const invocation = submitIntakeCommand.invoke(
      registry,
      seededGrants,
      { tenantId: 'northwind-synthetic', scope: {} },
      {
        workItems: new RecordingWorkItemDouble(),
        uploads: new RecordingUploadDouble(),
        attempts: new InMemoryIntakeAttemptStore(),
        records: new InMemoryIntakeRecordStore(),
        intake: syntheticSubmission(),
      },
    );
    expect(invocation.decision).toMatchObject({ allowed: true, capabilityId: 'portal.intake' });
    await expect(invocation.result).resolves.toMatchObject({ outcome: 'submitted' });
  });

  it('denies scaffolded and Riverbend-disabled submission before provider effects', () => {
    const workItems = new RecordingWorkItemDouble();
    const input = {
      workItems,
      uploads: new RecordingUploadDouble(),
      attempts: new InMemoryIntakeAttemptStore(),
      records: new InMemoryIntakeRecordStore(),
      intake: syntheticSubmission(),
    };
    expect(() =>
      submitIntakeCommand.invoke(
        registry,
        [grant('scaffolded')],
        { tenantId: 'northwind-synthetic', scope: {} },
        input,
      ),
    ).toThrow(CapabilityDeniedError);
    expect(() =>
      submitIntakeCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        input,
      ),
    ).toThrow(CapabilityDeniedError);
    expect(workItems.calls).toHaveLength(0);
  });
});
