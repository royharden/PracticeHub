import { defineCommandHandler } from '@practicehub/platform-core';

import type { PaidServiceEvent } from '../event-port.js';

export interface ConsumePaidServiceEventCommandInput<TResult> {
  readonly event: PaidServiceEvent;
  readonly consume: (event: PaidServiceEvent) => Promise<TResult>;
}

/** Invoke with checkpoint=drain; requireCapability runs before any consumer effect. */
export const consumePaidServiceEventCommand = defineCommandHandler<
  ConsumePaidServiceEventCommandInput<unknown>,
  Promise<unknown>
>({
  capabilityId: 'cash.paid-service-loop',
  minimumState: 'simulated',
  handle: (_context, input) => input.consume(input.event),
});
