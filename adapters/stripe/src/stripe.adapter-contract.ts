import type { AdapterContract } from '@practicehub/platform-integration';

/** AUTH-006 / RAIL-008 payment-processor adapter. Vendor SDK types stay inside this package. */
export const stripeAdapterContract: AdapterContract = {
  adapterId: 'stripe-adapter',
  authorityId: 'AUTH-006',
  direction: 'bidirectional',
  systemOfRecord: 'stripe-simulated',
  identityMatch: 'tenant-scoped opaque customer and intent refs; never a clinical identifier',
  fieldClassificationCeiling: 'PHI',
  retryIdempotency: 'intent-id hash is the effect key; duplicate webhooks and retries reuse it',
  ordering: 'webhook sequence per tenant stream; gaps buffer, they do not dispatch a second send',
  reconciliation: 'landed-without-receipt is not a licence to send again; late webhooks attach to the original effect',
  errorOwnership: 'processor refusals stay on the adapter; ledger projection owns balance truth',
  monitoring: 'webhook gap, duplicate, and out-of-order counts; rail heartbeat AUTH-006',
  downtimeBehavior: 'fail closed; persist unknown state; never invent a receipt',
  exportFormat: 'opaque SKU + denylisted metadata + payloadRef; no clinical text',
  livenessProof: 'RAIL-008 stripe-sim four-class fixtures plus inbox gap/duplicate/out-of-order tests',
  lateOutcomeRuleClass: 'dedupe-idempotent',
};
