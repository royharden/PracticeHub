import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PenTestScope } from './pen-test-scope.js';
import { RemediationLoop, RemediationLoopError } from './remediation-loop.js';
import { SecurityPrepThreatModel } from './threat-model.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const load = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(`${root}modules/security-review-prep/fixtures/${name}`, 'utf8'),
  ) as Record<string, unknown>;

describe('WP-123 four-class fixtures invoke domain behavior', () => {
  it('HAPPY consumes WP-010 and wires WP-100/WP-121', () => {
    const happy = load('WP-123.HAPPY.json');
    expect(happy.synthetic).toBe(true);
    const model = new SecurityPrepThreatModel();
    model.consumeWp010TenancyModel();
    model.add({
      id: 'EW-SEC-01-T-AI',
      surface: 'ai-evals',
      threat: 'eval-harness prompt injection',
      mitigation: 'WP-100 eval floor',
      disposition: 'forward',
      ownerWorkPackage: 'WP-100',
    });
    const loop = new RemediationLoop();
    loop.wire({
      id: 'F-AI-01',
      threatId: 'EW-SEC-01-T-AI',
      workPackageId: 'WP-100',
      status: 'open',
    });
    loop.wire({
      id: 'F-PORT-01',
      threatId: 'EW-SEC-01-T-EXPORT',
      workPackageId: 'WP-121',
      status: 'open',
    });
    expect(model.list().some((row) => row.disposition === 'consumed')).toBe(true);
    expect(loop.list()).toHaveLength(2);
  });

  it('BOUNDARY keeps in-scope vs out-of-scope distinct', () => {
    const boundary = load('WP-123.BOUNDARY.json');
    expect(boundary.synthetic).toBe(true);
    const scope = new PenTestScope();
    scope.add({
      id: 'PT-AUTH',
      class: 'in-scope',
      name: 'authn',
      reason: 'EW-SEC-01',
    });
    scope.add({
      id: 'PT-CARD',
      class: 'out-of-scope',
      name: 'card',
      reason: 'D5',
    });
    expect(scope.inScope()[0]?.id).toBe('PT-AUTH');
    expect(scope.outOfScope()[0]?.id).toBe('PT-CARD');
  });

  it('FAILURE refuses an unwired package', () => {
    const failure = load('WP-123.FAILURE.json');
    expect(failure.synthetic).toBe(true);
    expect(() =>
      new RemediationLoop().wire({
        id: 'F-BAD',
        threatId: 'T',
        workPackageId: String(failure.badPackage),
        status: 'open',
      }),
    ).toThrowError(new RemediationLoopError('UNWIRED_PACKAGE'));
  });

  it('RECOVERY names refuse-until-wired', () => {
    const recovery = load('WP-123.RECOVERY.json');
    expect(recovery.synthetic).toBe(true);
    expect(recovery.action).toBe('refuse-until-finding-wired-to-wp-id');
  });
});
