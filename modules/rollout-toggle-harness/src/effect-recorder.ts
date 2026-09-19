import type { AuthorityDecision } from '@practicehub/platform-core';

import {
  HarnessError,
  recorderCategories,
  type EffectSnapshot,
  type RecorderEvent,
} from './contracts.js';

function bucket(): Record<string, RecorderEvent[]> {
  return {};
}

function pushTenant(index: Record<string, RecorderEvent[]>, event: RecorderEvent): void {
  const existing = index[event.tenantId] ?? [];
  index[event.tenantId] = [...existing, event];
}

export class EffectRecorder {
  readonly #ordered: RecorderEvent[] = [];
  readonly #bodyEntries = bucket();
  readonly #queuedIntents = bucket();
  readonly #sealedOutputs = bucket();
  readonly #drainedEffects = bucket();
  #lastDecision: AuthorityDecision | null = null;
  readonly #seenKeys = new Set<string>();

  public setDecision(decision: AuthorityDecision | null): void {
    this.#lastDecision = decision;
  }

  public record(event: RecorderEvent): void {
    if (!recorderCategories.includes(event.category)) {
      throw new HarnessError('UNKNOWN_EFFECT_CATEGORY', event.category);
    }
    const key = `${event.tenantId}:${event.category}:${event.operationId}:${event.effectId}:${event.checkpoint}`;
    if (this.#seenKeys.has(key)) {
      throw new HarnessError('DUPLICATE_RECORDER_EVENT', key);
    }
    this.#seenKeys.add(key);
    this.#ordered.push(event);
    if (event.category === 'bodyEntry') pushTenant(this.#bodyEntries, event);
    if (event.category === 'queuedIntent') pushTenant(this.#queuedIntents, event);
    if (event.category === 'sealedOutput') pushTenant(this.#sealedOutputs, event);
    if (event.category === 'drainedEffect') pushTenant(this.#drainedEffects, event);
  }

  public assertExclusiveKey(tenantId: string, operationId: string): void {
    const shared = this.#ordered.find(
      (event) => event.operationId === operationId && event.tenantId !== tenantId,
    );
    if (shared !== undefined) {
      throw new HarnessError('SHARED_RECORDER_KEY', operationId);
    }
  }

  public snapshot(): EffectSnapshot {
    const freeze = (
      index: Record<string, RecorderEvent[]>,
    ): Record<string, readonly RecorderEvent[]> => {
      const out: Record<string, readonly RecorderEvent[]> = {};
      for (const [tenantId, events] of Object.entries(index)) {
        out[tenantId] = [...events];
      }
      return out;
    };
    return {
      bodyEntries: freeze(this.#bodyEntries),
      queuedIntents: freeze(this.#queuedIntents),
      sealedOutputs: freeze(this.#sealedOutputs),
      drainedEffects: freeze(this.#drainedEffects),
      ordered: [...this.#ordered],
      lastDecision: this.#lastDecision,
    };
  }
}

export function tenantCount(
  index: Readonly<Record<string, readonly RecorderEvent[]>>,
  tenantId: string,
): number {
  return index[tenantId]?.length ?? 0;
}
