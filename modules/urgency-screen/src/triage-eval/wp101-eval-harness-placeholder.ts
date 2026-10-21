import type { ClassifierChangeRecord } from './types.js';

export const WP101_EVAL_HARNESS_PLACEHOLDER_ID = 'wp101-eval-harness-placeholder/v1' as const;

/**
 * The slice of the WP-101 eval harness this package needs: whether the harness and golden store
 * are up, and a durable place for approved classifier changes.
 */
export interface EvalHarnessPort {
  readonly contractId: string;
  isAvailable(): boolean;
  recordChange(change: ClassifierChangeRecord): void;
}

/**
 * PLACEHOLDER for WP-101 (`modules/ai-evals`, not integrated at base 5a9be52). In-memory only.
 * A later pass replaces it with the WP-101 eval-run and promotion-evidence store and retests.
 */
export class Wp101EvalHarnessPlaceholder implements EvalHarnessPort {
  public readonly contractId = WP101_EVAL_HARNESS_PLACEHOLDER_ID;
  #available = true;
  readonly #changes: ClassifierChangeRecord[] = [];

  public setAvailable(available: boolean): void {
    this.#available = available;
  }

  public isAvailable(): boolean {
    return this.#available;
  }

  public recordChange(change: ClassifierChangeRecord): void {
    if (!this.#available) {
      throw new Error('eval harness unavailable: screener tuning is frozen');
    }
    this.#changes.push(Object.freeze({ ...change }));
  }

  public changes(): readonly ClassifierChangeRecord[] {
    return Object.freeze([...this.#changes]);
  }
}
