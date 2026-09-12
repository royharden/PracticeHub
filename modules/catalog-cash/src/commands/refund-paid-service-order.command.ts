import { defineCommandHandler } from '@practicehub/platform-core';

import type { PaidServiceLoop, PaidServiceOrder, RefundInput } from '../paid-service-loop.js';

export interface RefundPaidServiceOrderCommandInput {
  readonly loop: PaidServiceLoop;
  readonly refund: Omit<RefundInput, 'capabilityAllowed'>;
}

export const refundPaidServiceOrderCommand = defineCommandHandler<
  RefundPaidServiceOrderCommandInput,
  Promise<PaidServiceOrder>
>({
  capabilityId: 'cash.paid-service-loop',
  minimumState: 'simulated',
  handle: (_context, input) => input.loop.refund({ ...input.refund, capabilityAllowed: true }),
});
