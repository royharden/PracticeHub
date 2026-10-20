import { describe, expect, it } from 'vitest';

import { RcmShadowError } from '../contracts.js';

import {
  AT,
  ATTACH_ACTOR,
  CODER_REF,
  harness,
  itemInput,
  REVIEW_AT,
  SERVICE_ACTOR,
  SESSIONS,
  SUGGEST_THREE,
  TENANT,
} from './fixtures.test-support.js';
import { MODEL_SIM_CODING_PIN } from './model-sim.js';

describe('WP-087 reviewer flow end to end', () => {
  it('enqueues, suggests, reviews (accept, modify, reject, add) and attaches with provenance', async () => {
    const { gateway, worklist, claims } = harness({ 'enc-1': SUGGEST_THREE });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);

    const suggested = await worklist.requestSuggestions('wl-1', {
      actorRef: SERVICE_ACTOR,
      at: AT,
    });
    expect(suggested.state).toBe('awaiting-review');
    expect(suggested.suggestions.map((s) => s.code)).toEqual(['99214', 'E11.9', '36415']);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?.purpose).toBe('coding-suggestion-for-human-review');
    expect(gateway.calls[0]?.mode).toBe('dev');
    expect(worklist.queue(TENANT).map((i) => i.input.itemId)).toEqual(['wl-1']);

    // Nothing is on the claim while suggestions wait for a human.
    expect(claims.lines('clm-1')).toHaveLength(0);

    const [s1, s2, s3] = suggested.suggestions;
    if (s1 === undefined || s2 === undefined || s3 === undefined) throw new Error('fixture');
    const reviewed = worklist.review('wl-1', {
      reviewerSessionRef: SESSIONS.coder,
      reviewedAt: REVIEW_AT,
      decisions: [
        {
          suggestionId: s1.suggestionId,
          action: 'modify',
          system: 'CPT',
          code: '99213',
          units: 1,
          reason: 'synthetic MDM is low',
        },
        { suggestionId: s2.suggestionId, action: 'accept' },
        { suggestionId: s3.suggestionId, action: 'reject', reason: 'no draw documented' },
      ],
      manualCodes: [{ system: 'ICD-10-CM', code: 'I10', units: 1 }],
    });
    expect(reviewed.map((c) => c.code)).toEqual(['99213', 'E11.9', 'I10']);
    expect(reviewed.every((c) => c.reviewerRef === CODER_REF)).toBe(true);
    expect(worklist.item('wl-1').state).toBe('reviewed');

    const lines = worklist.attach('wl-1', claims, REVIEW_AT, ATTACH_ACTOR);
    expect(lines.map((l) => [l.code, l.origin.kind])).toEqual([
      ['99213', 'suggestion-modified'],
      ['E11.9', 'suggestion-accepted'],
      ['I10', 'human-entered'],
    ]);
    expect(claims.lines('clm-1')).toHaveLength(3);
    expect(worklist.item('wl-1').state).toBe('attached');
    expect(worklist.queue(TENANT)).toHaveLength(0);

    const modified = lines[0]?.origin;
    expect(modified?.kind === 'suggestion-modified' && modified.suggestedCode).toBe('99214');

    expect(worklist.events('wl-1').map((e) => [e.kind, e.actorRef])).toEqual([
      ['enqueued', SERVICE_ACTOR],
      ['suggestions-received', SERVICE_ACTOR],
      ['reviewed', CODER_REF],
      ['attached', ATTACH_ACTOR],
    ]);
  });

  it('lets a reviewer code a manual item with no suggestions, even while the kill switch is engaged', async () => {
    const { worklist, claims } = harness({}, { killed: true });
    worklist.enqueue(itemInput(2), AT, SERVICE_ACTOR);
    const manual = await worklist.requestSuggestions('wl-2', { actorRef: SERVICE_ACTOR, at: AT });
    expect(manual.state).toBe('manual');
    const reviewed = worklist.review('wl-2', {
      reviewerSessionRef: SESSIONS.coder,
      reviewedAt: REVIEW_AT,
      decisions: [],
      manualCodes: [{ system: 'CPT', code: '99213', units: 1 }],
    });
    expect(reviewed[0]?.origin).toEqual({ kind: 'human-entered' });
    expect(worklist.attach('wl-2', claims, REVIEW_AT, ATTACH_ACTOR)).toHaveLength(1);
  });

  it('refuses to attach to a claim that has left draft', async () => {
    const { worklist, claims } = harness({ 'enc-1': SUGGEST_THREE }, { claimState: 'submitted' });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    worklist.review('wl-1', {
      reviewerSessionRef: SESSIONS.coder,
      reviewedAt: REVIEW_AT,
      decisions: item.suggestions.map((s) => ({
        suggestionId: s.suggestionId,
        action: 'accept' as const,
      })),
      manualCodes: [],
    });
    expect(() => worklist.attach('wl-1', claims, REVIEW_AT, ATTACH_ACTOR)).toThrow(/draft claim/);
  });

  it('records the attaching actor and refuses a malformed one (review minor: attach actor)', async () => {
    const { worklist, claims } = harness({}, { killed: true });
    worklist.enqueue(itemInput(3), AT, SERVICE_ACTOR);
    await worklist.requestSuggestions('wl-3', { actorRef: SERVICE_ACTOR, at: AT });
    worklist.review('wl-3', {
      reviewerSessionRef: SESSIONS.coder,
      reviewedAt: REVIEW_AT,
      decisions: [],
      manualCodes: [],
    });
    expect(() => worklist.attach('wl-3', claims, REVIEW_AT, 'bad actor')).toThrow(/actorRef/);
    expect(worklist.attach('wl-3', claims, REVIEW_AT, ATTACH_ACTOR)).toEqual([]);
    expect(worklist.events('wl-3').at(-1)).toMatchObject({
      kind: 'attached',
      actorRef: ATTACH_ACTOR,
    });
  });
});

describe('WP-087 suggestion provenance', () => {
  it('stamps every suggestion with the interaction, output hash, model pin and documentation', async () => {
    const { worklist } = harness({ 'enc-1': SUGGEST_THREE });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    expect(item.suggestions).toHaveLength(3);
    for (const suggestion of item.suggestions) {
      const p = suggestion.provenance;
      expect(p.source).toBe('ai-gateway');
      expect(p.useCase).toBe('rcm.coding-suggestion');
      expect(p.interactionRef).toBe('coding:wl-1:1');
      expect(p.outputRef).toBe('object:model-sim:coding:wl-1:1');
      expect(p.outputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(p.modelRef).toBe(MODEL_SIM_CODING_PIN.modelRef);
      expect(p.pinnedModelVersion).toBe(MODEL_SIM_CODING_PIN.pinnedModelVersion);
      expect(p.promptTemplateVersion).toBe(MODEL_SIM_CODING_PIN.promptTemplateVersion);
      expect(p.bindingVersion).toBe(1);
      expect(p.grantVersion).toBe(1);
      expect(p.documentationRef).toBe('doc-1');
      expect(p.documentationHash).toBe(itemInput(1).documentationHash);
      expect(p.requestedAt).toBe(AT);
      expect(Object.isFrozen(p)).toBe(true);
    }
  });

  it('carries provenance through review onto the claim line', async () => {
    const { worklist, claims } = harness({ 'enc-1': SUGGEST_THREE });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    worklist.review('wl-1', {
      reviewerSessionRef: SESSIONS.coder,
      reviewedAt: REVIEW_AT,
      decisions: item.suggestions.map((s) => ({
        suggestionId: s.suggestionId,
        action: 'accept' as const,
      })),
      manualCodes: [],
    });
    for (const line of worklist.attach('wl-1', claims, REVIEW_AT, ATTACH_ACTOR)) {
      expect(line.origin.kind).toBe('suggestion-accepted');
      if (line.origin.kind !== 'human-entered') {
        expect(line.origin.provenance.interactionRef).toBe('coding:wl-1:1');
      }
    }
  });
});

describe('WP-087 fail-closed fallbacks to human-only coding', () => {
  const cases = [
    ['blocked', { kind: 'blocked', reason: 'prompt-injection' }],
    ['stale', { kind: 'stale', reason: 'model-version-drift' }],
    ['contained', { kind: 'contained' }],
    ['malformed-output', { kind: 'suggest', body: 'not json' }],
    [
      'malformed-output',
      {
        kind: 'suggest',
        body: JSON.stringify({
          suggestions: [
            { system: 'CPT', code: 'DROP TABLE', units: 1, rationale: 'x', confidence: 0.5 },
          ],
        }),
      },
    ],
    [
      'malformed-output',
      {
        kind: 'suggest',
        body: JSON.stringify({
          suggestions: [{ system: 'CPT', code: '99214', units: 1, rationale: 'x', confidence: 7 }],
        }),
      },
    ],
    [
      'malformed-output',
      {
        kind: 'suggest',
        body: JSON.stringify({
          suggestions: [
            { system: 'ICD-10-CM', code: 'E11.9', units: 3, rationale: 'x', confidence: 0.5 },
          ],
        }),
      },
    ],
    ['no-suggestions', { kind: 'suggest', body: JSON.stringify({ suggestions: [] }) }],
  ] as const;

  it.each(cases)('falls back to manual on %s', async (reason, script) => {
    const { worklist, claims } = harness({ 'enc-1': script });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    expect(item.state).toBe('manual');
    expect(item.manualReason).toBe(reason);
    expect(item.suggestions).toHaveLength(0);
    expect(claims.lines('clm-1')).toHaveLength(0);
  });

  it('refuses an output whose hash does not match', async () => {
    const { gateway, worklist } = harness({ 'enc-1': SUGGEST_THREE });
    const original = gateway.readOutput.bind(gateway);
    gateway.readOutput = (tenantId, outputRef) => original(tenantId, outputRef, '0'.repeat(64));
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    expect(item.manualReason).toBe('malformed-output');
  });

  it('retries a manual item after the kill switch is released', async () => {
    const { kill, worklist, gateway } = harness({ 'enc-1': SUGGEST_THREE }, { killed: true });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    expect(
      (await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT })).manualReason,
    ).toBe('kill-switch');
    expect(gateway.calls).toHaveLength(0);
    kill.engagedNow = false;
    const retried = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    expect(retried.state).toBe('awaiting-review');
    expect(retried.suggestions[0]?.provenance.interactionRef).toBe('coding:wl-1:1');
  });
});

describe('WP-087 input validation', () => {
  it('rejects duplicate items, bad hashes and bad timestamps', () => {
    const { worklist } = harness({});
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    expect(() => worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR)).toThrow(RcmShadowError);
    expect(() =>
      worklist.enqueue(itemInput(2, { documentationHash: 'abc' }), AT, SERVICE_ACTOR),
    ).toThrow(/sha256/);
    expect(() => worklist.enqueue(itemInput(3), '2026-01-05 10:00', SERVICE_ACTOR)).toThrow(/UTC/);
    expect(() => worklist.item('missing')).toThrow(/no worklist item/);
  });

  it('requires a decision on every suggestion, once, with reasons', async () => {
    const { worklist } = harness({ 'enc-1': SUGGEST_THREE });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    const ids = item.suggestions.map((s) => s.suggestionId);
    const base = { reviewerSessionRef: SESSIONS.coder, reviewedAt: REVIEW_AT, manualCodes: [] };
    expect(() =>
      worklist.review('wl-1', {
        ...base,
        decisions: [{ suggestionId: ids[0] ?? '', action: 'accept' }],
      }),
    ).toThrow(/every suggestion/);
    expect(() =>
      worklist.review('wl-1', {
        ...base,
        decisions: ids.map((id) => ({ suggestionId: id, action: 'reject' as const, reason: '' })),
      }),
    ).toThrow(/rejection needs a reason/);
    expect(() =>
      worklist.review('wl-1', {
        ...base,
        decisions: [...ids, ids[0] ?? ''].map((id) => ({
          suggestionId: id,
          action: 'accept' as const,
        })),
      }),
    ).toThrow(/duplicate decision/);
    expect(() =>
      worklist.review('wl-1', {
        ...base,
        decisions: [{ suggestionId: 'wl-1:A9:S9', action: 'accept' }],
      }),
    ).toThrow(/unknown suggestion/);
    // A failed review leaves the item open for the human.
    expect(worklist.item('wl-1').state).toBe('awaiting-review');
  });
});
