import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { leftoverCommIds } from './acceptance-dispositions.js';
import { CommRehearsal } from './rehearsal.js';

const directory = fileURLToPath(new URL('../fixtures', import.meta.url));

interface Case {
  readonly name: string;
  readonly op: string;
  readonly expectStatus?: string;
  readonly expectError?: string;
  readonly expectNext?: string;
  readonly expectAudit?: string;
}

const fixtureOps = [
  'stop-marketing-send-treatment',
  'stop-marketing-send-marketing',
  'undeliverable-sms',
  'email-no-phi',
  'email-with-phi',
  'email-phi-then-clean',
  'quiet-hours-defer',
  'quiet-hours-release',
  '10dlc-recover-send',
  '10dlc-recover-without-reject',
  '10dlc-block',
] as const;

function runOp(op: string) {
  const r = new CommRehearsal();
  switch (op) {
    case 'stop-marketing-send-treatment':
      r.stop('marketing');
      return r.send({
        scope: 'treatment',
        channel: 'sms',
        body: 'ok',
        containsPhi: false,
        synthetic: true,
      });
    case 'stop-marketing-send-marketing':
      r.stop('marketing');
      return r.send({
        scope: 'marketing',
        channel: 'sms',
        body: 'ad',
        containsPhi: false,
        synthetic: true,
      });
    case 'undeliverable-sms':
      return r.undeliverableSms();
    case 'email-no-phi':
      return r.send({
        scope: 'operations',
        channel: 'email',
        body: 'notice',
        containsPhi: false,
        synthetic: true,
      });
    case 'email-with-phi':
      return r.send({
        scope: 'operations',
        channel: 'email',
        body: 'labs',
        containsPhi: true,
        synthetic: true,
      });
    case 'email-phi-then-clean':
      try {
        r.send({
          scope: 'operations',
          channel: 'email',
          body: 'labs',
          containsPhi: true,
          synthetic: true,
        });
      } catch {
        /* rehearsal: PHI email rejected, then send a clean notice */
      }
      return r.send({
        scope: 'operations',
        channel: 'email',
        body: 'notice',
        containsPhi: false,
        synthetic: true,
      });
    case 'quiet-hours-defer':
      r.setQuietHours(true);
      return r.send({
        scope: 'operations',
        channel: 'sms',
        body: 'touch',
        containsPhi: false,
        synthetic: true,
      });
    case 'quiet-hours-release':
      r.setQuietHours(true);
      r.send({
        scope: 'operations',
        channel: 'sms',
        body: 'touch',
        containsPhi: false,
        synthetic: true,
      });
      return r.deliverDeferred();
    case '10dlc-recover-send':
      r.reject10dlc();
      r.recover10dlc();
      return r.send({
        scope: 'marketing',
        channel: 'sms',
        body: 'campaign',
        containsPhi: false,
        synthetic: true,
      });
    case '10dlc-recover-without-reject':
      return r.recover10dlc();
    case '10dlc-block':
      r.reject10dlc();
      return r.send({
        scope: 'marketing',
        channel: 'sms',
        body: 'campaign',
        containsPhi: false,
        synthetic: true,
      });
    default:
      throw new Error(`unknown op ${op}`);
  }
}

function runCase(fixtureCase: Case): void {
  if (fixtureCase.expectError !== undefined) {
    expect(() => runOp(fixtureCase.op)).toThrow(fixtureCase.expectError);
    return;
  }
  const result = runOp(fixtureCase.op) as {
    readonly status?: string;
    readonly next?: string;
    readonly audit?: string;
  };
  if (fixtureCase.expectStatus !== undefined) {
    expect(result.status).toBe(fixtureCase.expectStatus);
  }
  if (fixtureCase.expectNext !== undefined) {
    expect(result.next).toBe(fixtureCase.expectNext);
  }
  if (fixtureCase.expectAudit !== undefined) {
    expect(result.audit).toBe(fixtureCase.expectAudit);
  }
}

for (const requirementId of leftoverCommIds) {
  describe(`${requirementId} fixture pack`, () => {
    const pack = loadRequirementFixturePack(directory, requirementId);
    it('carries the complete four-class floor and a closed operation vocabulary', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as { cases: readonly Case[] };
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(fixtureOps).toContain(fixtureCase.op);
        }
      }
    });
    for (const fixtureClass of requiredFixtureClasses) {
      const fixture = pack.fixtures[fixtureClass] as { cases: readonly Case[] };
      for (const fixtureCase of fixture.cases) {
        it(`${fixtureClass}: ${fixtureCase.name}`, () => {
          runCase(fixtureCase);
        });
      }
    }
  });
}
