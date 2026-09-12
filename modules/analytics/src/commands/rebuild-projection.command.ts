import type { CapabilityId } from '@practicehub/platform-core';
import { defineCommandHandler } from '@practicehub/platform-core';

import { rebuildProjection } from '../rebuild.js';

export const rebuildProjectionCommand = defineCommandHandler<
  Parameters<typeof rebuildProjection>[0],
  ReturnType<typeof rebuildProjection>
>({
  capabilityId: 'analytics.read-model' as CapabilityId,
  minimumState: 'simulated',
  handle: (_context, input) => rebuildProjection(input),
});
