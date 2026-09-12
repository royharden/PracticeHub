import { describe, expect, it } from 'vitest';

import { isolateContent, sha256, validateGatewayRequest } from './guards.js';
import { requestFixture } from './test-support.js';

describe('context isolation independent of object-store behavior', () => {
  it('refuses a body and declaration that agree with each other but not the request subject', () => {
    const request = requestFixture();
    const body = 'synthetic cross-subject body';
    const ref = {
      tenantId: request.tenantId,
      subjectRef: 'subject:northwind:002',
      bodyRef: 'source:note:002',
      bodyHash: sha256(body),
      originRef: 'ehr:synthetic-note',
      trust: 'untrusted-data' as const,
      synthetic: true as const,
    };
    expect(() => isolateContent({ ...request, content: [ref] }, [{ ...ref, body }])).toThrow(
      'outside request scope',
    );
  });

  it('refuses a known other subject named inside an otherwise correctly scoped body', () => {
    const request = requestFixture();
    const body = 'Clinical facts belonging to subject:northwind:002';
    const declared = request.content[0];
    if (declared === undefined) throw new Error('fixture source missing');
    const ref = { ...declared, bodyHash: sha256(body) };

    expect(() => isolateContent({ ...request, content: [ref] }, [{ ...ref, body }])).toThrow(
      'another known subject',
    );
  });
});

describe('pinned gateway calendar', () => {
  it('refuses impossible instants and an asOf day different from execution', () => {
    expect(() =>
      validateGatewayRequest(
        requestFixture({
          occurredAt: '2026-02-30T09:00:00Z',
          asOf: '2026-02-30',
        }),
      ),
    ).toThrow('real calendar');
    expect(() => validateGatewayRequest(requestFixture({ asOf: '2026-05-31' }))).toThrow(
      'execution day',
    );
  });
});
