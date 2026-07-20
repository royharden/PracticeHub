/**
 * Command-handler construction (WP-012). Contract:
 * docs/contracts/capability-registry.md (FROZEN).
 *
 * Every side-effecting command handler is constructed through
 * `defineCommandHandler`, which binds the capability the handler moves under
 * and performs the `requireCapability` check BEFORE the handler body runs —
 * the AuthorityDecision is returned alongside the result so the caller can
 * attach it to the audit trail (WP-020 wires the emit). Handlers live in
 * `modules/<m>/src/commands/*.command.ts` (same for adapters); the
 * handler-coverage lint (`pnpm verify:handlers`) fails any command file whose
 * exports are not built through this constructor.
 *
 * Checks run at BOTH enqueue and drain time; drain is authoritative — the
 * queue substrate (WP-021) re-invokes with `checkpoint: 'drain'` before any
 * side effect so kill-switch/rollback transitions drain safely.
 */

import {
  requireCapability,
  type AuthorityDecision,
  type CapabilityContext,
  type CapabilityGrant,
  type CapabilityId,
  type CapabilityRegistry,
  type CapabilityState,
  type RequireCapabilityOptions,
} from './capability.js';

export interface CommandHandlerSpec<TInput, TResult> {
  readonly capabilityId: CapabilityId;
  /** Grant-state floor for this handler; defaults to `pilot` (live authority). */
  readonly minimumState?: CapabilityState;
  readonly handle: (context: CapabilityContext, input: TInput) => TResult;
}

export interface CommandInvocation<TResult> {
  readonly decision: AuthorityDecision;
  readonly result: TResult;
}

export interface CommandHandler<TInput, TResult> {
  readonly capabilityId: CapabilityId;
  readonly minimumState: CapabilityState;
  readonly invoke: (
    registry: CapabilityRegistry,
    grants: readonly CapabilityGrant[],
    context: CapabilityContext,
    input: TInput,
    options?: Pick<RequireCapabilityOptions, 'checkpoint' | 'registryVersion' | 'purpose'>,
  ) => CommandInvocation<TResult>;
}

export function defineCommandHandler<TInput, TResult>(
  spec: CommandHandlerSpec<TInput, TResult>,
): CommandHandler<TInput, TResult> {
  const minimumState = spec.minimumState ?? 'pilot';
  return {
    capabilityId: spec.capabilityId,
    minimumState,
    invoke: (registry, grants, context, input, options = {}) => {
      const decision = requireCapability(registry, grants, context, spec.capabilityId, {
        minimumState,
        ...options,
      });
      return { decision, result: spec.handle(context, input) };
    },
  };
}
