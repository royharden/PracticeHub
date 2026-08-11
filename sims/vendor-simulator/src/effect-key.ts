/**
 * The effect-key contract every rail of this service shares (WP-027 §4, lifted
 * to its own module by WP-028 so both rail files bind the SAME factory instead
 * of re-deriving the grammar per file).
 *
 * The key is what makes "one external effect per idempotency key" decidable: the
 * ledger is keyed by it, so two rails may never collide and one rail may never
 * split one caller intent across two keys.
 */

import type { RailRequest } from '@practicehub/vendor-sim-kit';

export const effectKeyFactory =
  (railSlug: string) =>
  (operation: string, request: RailRequest): string =>
    `synthetic:${railSlug}/${operation}/${request.idempotencyKey}`;
