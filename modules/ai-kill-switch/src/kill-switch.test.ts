import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KillSwitchConsole } from './kill-switch.js';
import { ReenableConsole } from './reenable.js';
import type { CsatSample, TenantId, TouchpointDefinition, TouchpointId } from './types.js';
import { KillSwitchError } from './types.js';
import { Wp101EvalDouble } from './wp101-eval-double.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const tenant = 'northwind-synthetic' as TenantId;
const chat = 'touchpoint:member-chat' as TouchpointId;
const voice = 'touchpoint:member-voice' as TouchpointId;
const now = '2026-09-18T12:00:00.000Z';
const nowMs = Date.parse(now);

function def(touchpointId: TouchpointId): TouchpointDefinition {
  return {
    contractId: 'ai-kill-switch-touchpoint/v1',
    tenantId: tenant,
    touchpointId,
    label: String(touchpointId),
    memberFacing: true,
    csatBaseline: 4.0,
    csatDropThreshold: 0.3,
    minSample: 3,
    complaintRateThreshold: 0.4,
    instrumentationTtlMs: 86_400_000,
    reviewSlaMs: 86_400_000,
    synthetic: true,
  };
}

function sample(
  touchpointId: TouchpointId,
  score: number,
  extra: Partial<CsatSample> = {},
): CsatSample {
  return {
    tenantId: tenant,
    touchpointId,
    at: extra.at ?? now,
    score,
    complaint: extra.complaint ?? false,
    optOut: extra.optOut ?? false,
    missedEscalation: extra.missedEscalation ?? false,
    deceptiveDisclosure: extra.deceptiveDisclosure ?? false,
    sentinel: extra.sentinel ?? false,
    cohort: extra.cohort ?? 'legacy-vintage',
    attributionTag: extra.attributionTag ?? 'ai-touchpoint',
    contained: extra.contained ?? false,
    inFlightRef: extra.inFlightRef ?? null,
    synthetic: true,
  };
}

function consolePair(): {
  kills: KillSwitchConsole;
  reenable: ReenableConsole;
  evals: Wp101EvalDouble;
} {
  const kills = new KillSwitchConsole();
  kills.register(def(chat));
  kills.register(def(voice));
  const evals = new Wp101EvalDouble();
  return { kills, evals, reenable: new ReenableConsole(kills, evals) };
}

describe('REQ-AI-060 fixtures are four-class and named', () => {
  it('loads HAPPY BOUNDARY FAILURE RECOVERY with unique case names', () => {
    const names = new Set<string>();
    for (const cls of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
      const raw = JSON.parse(readFileSync(join(fixtureRoot, `REQ-AI-060.${cls}.json`), 'utf8')) as {
        requirementId: string;
        class: string;
        cases: readonly { name: string }[];
      };
      expect(raw.requirementId).toBe('REQ-AI-060');
      expect(raw.class).toBe(cls);
      expect(raw.cases.length).toBeGreaterThan(0);
      for (const row of raw.cases) {
        expect(names.has(row.name)).toBe(false);
        names.add(row.name);
      }
    }
    expect(names.size).toBe(10);
  });
});

describe('HAPPY', () => {
  it('threshold csat drop kills one touchpoint and hands off in-flight', () => {
    const { kills } = consolePair();
    for (const score of [3.5, 3.5, 3.5]) {
      kills.recordAndMaybeKill(sample(chat, score, { inFlightRef: 'turn-9' }), nowMs);
    }
    expect(kills.path(tenant, chat)).toBe('human-only');
    expect(kills.path(tenant, voice)).toBe('ai');
    expect(kills.currentKill(tenant, chat)?.alerted).toEqual([
      'ai-safety-owner',
      'governance-board',
    ]);
    expect(kills.fallback.forTouchpoint(tenant, chat)[0]?.deadEnd).toBe(false);
    expect(kills.lastReview(tenant, chat)?.kind).toBe('auto-kill');
    expect(kills.lastReview(tenant, chat)?.slaDueAt).toBe('2026-09-19T12:00:00.000Z');
  });

  it('governed re-enable after dual sign-off and golden-set floors', () => {
    const { kills, reenable, evals } = consolePair();
    for (const score of [3.4, 3.4, 3.4]) {
      kills.recordAndMaybeKill(sample(chat, score), nowMs);
    }
    expect(kills.path(tenant, chat)).toBe('human-only');
    const path = reenable.apply({
      tenantId: tenant,
      touchpointId: chat,
      practiceManagerSignOff: 'pm:alex',
      governanceBoardSignOff: 'board:gov-1',
      goldenSet: evals.evidenceFor(chat, true),
      supervisedRepilotCleared: true,
      decidedAt: now,
      synthetic: true,
    });
    expect(path).toBe('ai');
  });
});

describe('BOUNDARY', () => {
  it('single anecdotal complaint below min sample does not kill', () => {
    const { kills } = consolePair();
    kills.recordAndMaybeKill(sample(chat, 4.0, { complaint: true }), nowMs);
    expect(kills.path(tenant, chat)).toBe('ai');
  });

  it('exact baseline minus threshold is not a drop; one more point drop kills', () => {
    const { kills } = consolePair();
    kills.recordAndMaybeKill(sample(chat, 3.7), nowMs);
    kills.recordAndMaybeKill(sample(chat, 3.7), nowMs);
    kills.recordAndMaybeKill(sample(chat, 3.7), nowMs);
    expect(kills.path(tenant, chat)).toBe('ai');
    kills.recordAndMaybeKill(sample(chat, 3.0), nowMs);
    expect(kills.path(tenant, chat)).toBe('human-only');
  });
});

describe('FAILURE', () => {
  it('silent toggle re-enable is prohibited', () => {
    const { kills } = consolePair();
    kills.kill({
      tenantId: tenant,
      touchpointId: chat,
      at: now,
      reason: 'csat-drop',
      rationale: 'test',
      inFlightRef: null,
    });
    expect(() => kills.assertNotToggle(tenant, chat)).toThrow(KillSwitchError);
    expect(() => kills.disableThisControl()).toThrow(/cannot be disabled/);
  });

  it('re-enable without golden-set floors is refused', () => {
    const { kills, reenable, evals } = consolePair();
    kills.kill({
      tenantId: tenant,
      touchpointId: chat,
      at: now,
      reason: 'csat-drop',
      rationale: 'test',
      inFlightRef: null,
    });
    expect(() =>
      reenable.apply({
        tenantId: tenant,
        touchpointId: chat,
        practiceManagerSignOff: 'pm:alex',
        governanceBoardSignOff: 'board:gov-1',
        goldenSet: evals.evidenceFor(chat, false),
        supervisedRepilotCleared: true,
        decidedAt: now,
        synthetic: true,
      }),
    ).toThrow(/floors not met/);
    expect(kills.path(tenant, chat)).toBe('human-only');
  });

  it('missing instrumentation fails closed to human', () => {
    const { kills } = consolePair();
    expect(kills.admit(tenant, chat, now, nowMs, 'turn-1')).toBe('human-only');
    expect(kills.currentKill(tenant, chat)?.reason).toBe('missing-instrumentation');
  });
});

describe('RECOVERY', () => {
  it('sentinel pause is immediate regardless of csat', () => {
    const { kills } = consolePair();
    kills.recordAndMaybeKill(sample(chat, 5, { sentinel: true, inFlightRef: 's1' }), nowMs);
    expect(kills.path(tenant, chat)).toBe('human-only');
    expect(kills.currentKill(tenant, chat)?.reason).toBe('sentinel');
  });

  it('deceptive-disclosure complaint forces review kill', () => {
    const { kills } = consolePair();
    kills.recordAndMaybeKill(sample(chat, 5, { deceptiveDisclosure: true }), nowMs);
    expect(kills.currentKill(tenant, chat)?.reason).toBe('deceptive-disclosure');
  });

  it('killed in-flight member is handed to human never a dead end', () => {
    const { kills } = consolePair();
    kills.kill({
      tenantId: tenant,
      touchpointId: chat,
      at: now,
      reason: 'missed-escalation',
      rationale: 'missed',
      inFlightRef: 'live-22',
    });
    const handoff = kills.fallback.forTouchpoint(tenant, chat)[0];
    expect(handoff?.inFlightRef).toBe('live-22');
    expect(handoff?.deadEnd).toBe(false);
  });
});

describe('0079 notes: AC1/AC5/AC6', () => {
  it('ignores general-service complaints when scoring AI kill', () => {
    const { kills } = consolePair();
    kills.recordAndMaybeKill(
      sample(chat, 4, { attributionTag: 'general-service', complaint: true }),
      nowMs,
    );
    kills.recordAndMaybeKill(
      sample(chat, 4, { attributionTag: 'general-service', complaint: true }),
      nowMs,
    );
    kills.recordAndMaybeKill(
      sample(chat, 4, { attributionTag: 'general-service', complaint: true }),
      nowMs,
    );
    expect(kills.path(tenant, chat)).toBe('ai');
  });

  it('records containment rate and legacy-vintage cohort without global kill', () => {
    const { kills } = consolePair();
    kills.recordAndMaybeKill(sample(chat, 4, { contained: true, cohort: 'legacy-vintage' }), nowMs);
    kills.recordAndMaybeKill(
      sample(chat, 4, { contained: false, cohort: 'legacy-vintage' }),
      nowMs,
    );
    expect(kills.monitor.containmentRate(tenant, chat)).toBe(0.5);
    expect(kills.path(tenant, voice)).toBe('ai');
  });
});

describe('R6-REQ-105 runtime disable without deploy', () => {
  it('runtime kill does not require a second touchpoint deploy flag', () => {
    const { kills } = consolePair();
    kills.kill({
      tenantId: tenant,
      touchpointId: voice,
      at: now,
      reason: 'complaint-trend',
      rationale: 'runtime',
      inFlightRef: null,
    });
    expect(kills.path(tenant, voice)).toBe('human-only');
    expect(kills.path(tenant, chat)).toBe('ai');
  });
});
