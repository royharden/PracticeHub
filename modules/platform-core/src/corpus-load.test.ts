import { describe, expect, it } from 'vitest';

import { CapabilityDeniedError, type CapabilityGrant } from './capability.js';
import { capabilityDefinitionsV1, capabilityRegistryV1 } from './capability-definitions.js';
import { loadCorpusVersionCommand } from './commands/load-corpus-version.command.js';
import {
  CorpusLoadRefusedError,
  validateCorpusLoadRequest,
  type CorpusLoadRequest,
} from './corpus-load.js';

const tenant = 'northwind-synthetic';
const context = { tenantId: tenant, scope: {} };

const request: CorpusLoadRequest = {
  tenantId: tenant,
  corpusVersion: 'SynthCorpus-v1',
  recoveryEpoch: 'RE-001',
  manifestCheckpoint: 'a'.repeat(64),
  dataPolicy: 'synthetic-only',
  synthetic: true,
};

function grantAt(state: CapabilityGrant['state'], tenantId = tenant): CapabilityGrant[] {
  return [
    {
      capabilityId: 'platform.synthetic-corpus',
      tenantId,
      scope: {},
      state,
      sinceEventId: 'synthetic-cap-evt-0023',
      evidenceRefs: ['synthetic-gate:wp-029-synthetic-corpus-scaffold'],
      rollbackRef: 'corpus-version-drop',
      synthetic: true,
    },
  ];
}

describe('validateCorpusLoadRequest', () => {
  it('accepts a synthetic-only, fenced, pinned request', () => {
    expect(() => {
      validateCorpusLoadRequest(request);
    }).not.toThrow();
  });

  it('REFUSES a load that is not synthetic-only — no grant relaxes this', () => {
    const unsafe = { ...request, dataPolicy: 'production' } as unknown as CorpusLoadRequest;
    expect(() => {
      validateCorpusLoadRequest(unsafe);
    }).toThrow(CorpusLoadRefusedError);
    expect(() => {
      validateCorpusLoadRequest(unsafe);
    }).toThrow(/not synthetic-only/);
  });

  it('refuses a request without the synthetic watermark', () => {
    const unwatermarked = { ...request, synthetic: false } as unknown as CorpusLoadRequest;
    expect(() => {
      validateCorpusLoadRequest(unwatermarked);
    }).toThrow(/no synthetic watermark/);
  });

  it('refuses a floating corpus version — tests reference versions, never floating data', () => {
    expect(() => {
      validateCorpusLoadRequest({ ...request, corpusVersion: 'latest' });
    }).toThrow(/pinned SynthCorpus version/);
  });

  it('refuses a load that names no recovery epoch ordinal', () => {
    expect(() => {
      validateCorpusLoadRequest({ ...request, recoveryEpoch: 'yesterday' });
    }).toThrow(/RE-NNN ordinal/);
  });

  it('refuses an UNFENCED corpus — no verifiable checkpoint, no load', () => {
    expect(() => {
      validateCorpusLoadRequest({ ...request, manifestCheckpoint: '' });
    }).toThrow(/no verifiable manifest checkpoint/);
    expect(() => {
      validateCorpusLoadRequest({ ...request, manifestCheckpoint: 'A'.repeat(64) });
    }).toThrow(/no verifiable manifest checkpoint/);
  });

  it('refuses a load that names no tenant', () => {
    expect(() => {
      validateCorpusLoadRequest({ ...request, tenantId: '' });
    }).toThrow(/names its tenant/);
  });

  it('exposes NO override parameter — the refusal cannot be argued with', () => {
    expect(validateCorpusLoadRequest).toHaveLength(1);
  });
});

describe('loadCorpusVersionCommand', () => {
  it('is registered against a declared capability', () => {
    expect(
      capabilityDefinitionsV1.some(
        (definition) => definition.capabilityId === 'platform.synthetic-corpus',
      ),
    ).toBe(true);
    expect(loadCorpusVersionCommand.capabilityId).toBe('platform.synthetic-corpus');
    expect(loadCorpusVersionCommand.minimumState).toBe('simulated');
  });

  it('DENIES a load at the seeded package ceiling (scaffolded) — by design', () => {
    expect(() =>
      loadCorpusVersionCommand.invoke(capabilityRegistryV1, grantAt('scaffolded'), context, {
        request,
      }),
    ).toThrow(CapabilityDeniedError);
  });

  it('allows the load once the capability reaches simulated', () => {
    const invocation = loadCorpusVersionCommand.invoke(
      capabilityRegistryV1,
      grantAt('simulated'),
      context,
      { request },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.result).toBe(request);
  });

  it('Riverbend (disabled) cannot load — the standing opposite-state negative', () => {
    expect(() =>
      loadCorpusVersionCommand.invoke(
        capabilityRegistryV1,
        grantAt('disabled', 'riverbend-synthetic'),
        { tenantId: 'riverbend-synthetic', scope: {} },
        { request },
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a grant cannot buy past the synthetic-only refusal — it sits BELOW the registry', () => {
    const unsafe = { ...request, dataPolicy: 'production' } as unknown as CorpusLoadRequest;
    expect(() =>
      loadCorpusVersionCommand.invoke(capabilityRegistryV1, grantAt('active'), context, {
        request: unsafe,
      }),
    ).toThrow(CorpusLoadRefusedError);
  });
});
