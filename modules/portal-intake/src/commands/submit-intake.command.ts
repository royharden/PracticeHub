import { defineCommandHandler } from '@practicehub/platform-core';

import { submitIntake, type SubmitIntakeInput } from '../intake.js';
import type {
  IntakeAttemptPort,
  IntakeRecordPort,
  IntakeUploadPort,
  IntakeWorkItemPort,
} from '../ports.js';

export interface SubmitIntakeCommandInput {
  readonly workItems: IntakeWorkItemPort;
  readonly uploads: IntakeUploadPort;
  readonly attempts: IntakeAttemptPort;
  readonly records: IntakeRecordPort;
  readonly intake: SubmitIntakeInput;
}

export const submitIntakeCommand = defineCommandHandler({
  capabilityId: 'portal.intake',
  minimumState: 'simulated',
  handle: (_context, input: SubmitIntakeCommandInput) =>
    submitIntake(input.workItems, input.uploads, input.attempts, input.records, input.intake),
});
