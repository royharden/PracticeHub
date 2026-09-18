import { createHash, randomUUID } from 'node:crypto';

import { ScopedAsyncLock } from './scoped-async-lock.js';
import type { CatalogDouble } from './testing/catalog-double.js';
import type { MembershipDouble } from './testing/membership-double.js';
import type { ConsumeCommand, ConsumeOutcome } from './types.js';

export class EntitlementsEngine {
  readonly #lock = new ScopedAsyncLock();
  readonly #consumed = new Map<string, { hash: string; outcome: ConsumeOutcome }>();
  readonly #spent = new Set<string>();

  constructor(
    private readonly catalog: CatalogDouble,
    private readonly membership: MembershipDouble,
  ) {}

  consume(command: ConsumeCommand): Promise<ConsumeOutcome> {
    const key = `${command.tenantId}:${command.memberRef}:${command.skuRef}`;
    return this.#lock.runExclusive(key, () => this.#consumeLocked(command));
  }

  #consumeLocked(command: ConsumeCommand): ConsumeOutcome {
    const idempotency = `${command.tenantId}:${command.idempotencyKey}`;
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const prior = this.#consumed.get(idempotency);
    if (prior) {
      if (prior.hash !== hash) {
        return { ok: false, code: 'DOUBLE_CONSUMPTION' };
      }
      return prior.outcome.ok ? { ok: false, code: 'IDEMPOTENT_REPLAY' } : prior.outcome;
    }

    const vintage = this.membership.get(command.memberRef);
    if (!vintage || vintage.vintageId !== command.vintageId) {
      return this.#store(idempotency, hash, { ok: false, code: 'VINTAGE_MISMATCH' });
    }
    if (vintage.state !== 'active') {
      return this.#store(idempotency, hash, { ok: false, code: 'MEMBERSHIP_FROZEN' });
    }

    const composition = this.catalog.get(command.skuRef);
    if (!composition) {
      return this.#store(idempotency, hash, { ok: false, code: 'COMPOSITION_INCOMPLETE' });
    }
    const billed = new Set(command.billedComponentRefs);
    const expected = new Set(composition.billedComponentRefs);
    if (billed.size !== expected.size || [...billed].some((ref) => !expected.has(ref))) {
      return this.#store(idempotency, hash, { ok: false, code: 'COMPOSITION_INCOMPLETE' });
    }
    if (composition.lines.some((line) => line.coverage === 'unclassified')) {
      return this.#store(idempotency, hash, { ok: false, code: 'UNCLASSIFIED_CANNOT_SELL' });
    }

    const coveredCents = composition.lines
      .filter((line) => billed.has(line.componentRef) && line.coverage === 'covered')
      .reduce((sum, line) => sum + line.amountCents, 0);
    const nonCoveredCents = composition.lines
      .filter((line) => billed.has(line.componentRef) && line.coverage === 'non-covered')
      .reduce((sum, line) => sum + line.amountCents, 0);

    if (command.discountCents > 0 && coveredCents > 0 && nonCoveredCents === 0) {
      return this.#store(idempotency, hash, { ok: false, code: 'DISCOUNT_ON_COVERED' });
    }
    if (command.discountCents > nonCoveredCents) {
      return this.#store(idempotency, hash, { ok: false, code: 'DISCOUNT_ON_COVERED' });
    }

    const spendKey = `${command.tenantId}:${command.memberRef}:${command.vintageId}:${command.skuRef}`;
    if (this.#spent.has(spendKey)) {
      return this.#store(idempotency, hash, { ok: false, code: 'DOUBLE_CONSUMPTION' });
    }
    this.#spent.add(spendKey);

    const outcome: ConsumeOutcome = {
      ok: true,
      consumptionId: randomUUID(),
      allowedDiscountCents: Math.min(command.discountCents, nonCoveredCents),
    };
    return this.#store(idempotency, hash, outcome);
  }

  #store(idempotency: string, hash: string, outcome: ConsumeOutcome): ConsumeOutcome {
    this.#consumed.set(idempotency, { hash, outcome });
    return outcome;
  }
}
