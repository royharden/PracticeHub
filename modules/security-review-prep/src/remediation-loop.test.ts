import { describe, expect, it } from 'vitest';

import { RemediationLoop, RemediationLoopError } from './remediation-loop.js';

describe('findings remediation loop', () => {
  it('wires a finding to a work package id', () => {
    const loop = new RemediationLoop();
    const wired = loop.wire({
      id: 'F-AI-01',
      threatId: 'EW-SEC-01-T-AI',
      workPackageId: 'WP-100',
      status: 'open',
    });
    expect(wired.status).toBe('wired');
    expect(loop.list()).toHaveLength(1);
  });

  it('rejects an unwired package token', () => {
    expect(() =>
      new RemediationLoop().wire({
        id: 'F-X',
        threatId: 'T',
        workPackageId: 'security-later',
        status: 'open',
      }),
    ).toThrowError(new RemediationLoopError('UNWIRED_PACKAGE'));
  });
});
