import { defineCommandHandler } from '@practicehub/platform-core';

import type { PaidServiceLoop, PaidServiceOrder, PurchaseInput } from '../paid-service-loop.js';

export interface CreatePaidServiceOrderCommandInput {
  readonly loop: PaidServiceLoop;
  readonly purchase: Omit<PurchaseInput, 'capabilityAllowed'>;
}

export const createPaidServiceOrderCommand = defineCommandHandler<
  CreatePaidServiceOrderCommandInput,
  Promise<PaidServiceOrder>
>({
  capabilityId: 'cash.paid-service-loop',
  minimumState: 'simulated',
  handle: (_context, input) => input.loop.purchase({ ...input.purchase, capabilityAllowed: true }),
});
