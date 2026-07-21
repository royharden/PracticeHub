import {
  capabilityRegistryV1,
  CapabilityDeniedError,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { replayOutboxCommand } from './commands/replay-outbox.command.js';

const tenant = 'northwind-synthetic';
const context = { tenantId: tenant, scope: {} };

function grantAt(state: CapabilityGrant['state'], tenantId = tenant): CapabilityGrant[] {
  return [
    {
      capabilityId: 'platform.event-spine',
      tenantId,
      scope: {},
      state,
      sinceEventId: 'synthetic-cap-evt-0015',
      evidenceRefs: ['synthetic-gate:wp-021-event-spine-scaffold'],
      rollbackRef: 'registry-event-replay',
      synthetic: true,
    },
  ];
}

describe('replay-outbox command (platform.event-spine, floored simulated)', () => {
  it('DENIES a live replay at the seeded package ceiling (scaffolded)', () => {
    expect(() =>
      replayOutboxCommand.invoke(capabilityRegistryV1, grantAt('scaffolded'), context, {
        delivery: { status: 'dead', attempts: 3 },
        alreadyConsumed: false,
      }),
    ).toThrow(CapabilityDeniedError);
  });

  it('allows replay once the capability reaches simulated, and never re-sends a landed effect', () => {
    const consumed = replayOutboxCommand.invoke(
      capabilityRegistryV1,
      grantAt('simulated'),
      context,
      {
        delivery: { status: 'published', attempts: 1 },
        alreadyConsumed: true,
      },
    );
    expect(consumed.result).toBe('reconciled-no-resend');
    const fresh = replayOutboxCommand.invoke(capabilityRegistryV1, grantAt('simulated'), context, {
      delivery: { status: 'failed', attempts: 2 },
      alreadyConsumed: false,
    });
    expect(fresh.result).toBe('resend-safe');
  });

  it('Riverbend (disabled) cannot replay — the standing opposite-state negative', () => {
    expect(() =>
      replayOutboxCommand.invoke(
        capabilityRegistryV1,
        grantAt('disabled', 'riverbend-synthetic'),
        { tenantId: 'riverbend-synthetic', scope: {} },
        { delivery: { status: 'failed', attempts: 1 }, alreadyConsumed: false },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
