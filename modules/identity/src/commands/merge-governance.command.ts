/**
 * Merge and unmerge are authority-bearing writes: they move under
 * `identity.merge-governance`, floored at `simulated`. WP-016 seeds the
 * capability at `scaffolded` (the package ceiling), so the seeded local grant
 * DENIES live merge execution — the activation walk to `simulated` belongs to
 * the package that takes M02 into the reference loops. Riverbend (disabled)
 * is the standing opposite-state proof. The domain functions remain directly
 * testable; these commands are the authority path.
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  executeMerge,
  executeUnmerge,
  type MergeExecution,
  type MergeExecutionInput,
  type UnmergeExecutionInput,
  type UnmergeOutcome,
} from '../merge.js';

export const executeMergeCommand = defineCommandHandler<MergeExecutionInput, MergeExecution>({
  capabilityId: 'identity.merge-governance',
  minimumState: 'simulated',
  handle: (_context, input) => executeMerge(input),
});

export const executeUnmergeCommand = defineCommandHandler<UnmergeExecutionInput, UnmergeOutcome>({
  capabilityId: 'identity.merge-governance',
  minimumState: 'simulated',
  handle: (_context, input) => executeUnmerge(input),
});
