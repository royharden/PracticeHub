import { describe, expect, it } from 'vitest';

import * as codingApi from './index.js';
import {
  AT,
  ATTACH_ACTOR,
  deferred,
  harness,
  itemInput,
  killSwitch,
  REQUESTER_REF,
  REVIEW_AT,
  reviewerDirectory,
  SERVICE_ACTOR,
  SESSIONS,
  SUGGEST_THREE,
  TENANT,
} from './fixtures.test-support.js';
import type { CodingGatewayPort } from './gateway-port.js';
import { createModelSimCodingGateway } from './model-sim.js';
import {
  rcmSourceFiles,
  scanNoAutonomy,
  type SourceFile,
} from './no-autonomy-scan.test-support.js';
import type { ReviewedCode } from './types.js';
import { CodingWorklist } from './worklist.js';

async function suggested(killed = false) {
  const h = harness({ 'enc-1': SUGGEST_THREE }, { killed });
  h.worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
  const item = await h.worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
  return { ...h, item };
}

function acceptAll(
  item: Awaited<ReturnType<typeof suggested>>['item'],
  reviewerSessionRef: string = SESSIONS.coder,
) {
  return {
    reviewerSessionRef,
    reviewedAt: REVIEW_AT,
    decisions: item.suggestions.map((s) => ({
      suggestionId: s.suggestionId,
      action: 'accept' as const,
    })),
    manualCodes: [],
  };
}

describe('WP-087 structural no-autonomy: claim ports', () => {
  it('a claim port refuses a code that no human review minted, even with identical fields', async () => {
    const { worklist, claims, item } = await suggested();
    const genuine = worklist.review('wl-1', acceptAll(item))[0];
    if (genuine === undefined) throw new Error('fixture');
    const forged: ReviewedCode = { ...genuine, reviewedCodeId: 'wl-1:R99' };
    const cloned: ReviewedCode = structuredClone(genuine);
    expect(codingApi.isReviewerMinted(genuine)).toBe(true);
    expect(codingApi.isReviewerMinted(forged)).toBe(false);
    expect(codingApi.isReviewerMinted(cloned)).toBe(false);
    expect(() => claims.attachReviewedCode(forged)).toThrow(/human reviewer action/);
    expect(() => claims.attachReviewedCode(cloned)).toThrow(/human reviewer action/);
    expect(claims.lines('clm-1')).toHaveLength(0);
  });

  it('a suggestion shaped into a claim code is refused', async () => {
    const { claims, item } = await suggested();
    const s = item.suggestions[0];
    if (s === undefined) throw new Error('fixture');
    const smuggled = {
      reviewedCodeId: s.suggestionId,
      itemId: s.itemId,
      tenantId: TENANT,
      claimId: 'clm-1',
      system: s.system,
      code: s.code,
      units: s.units,
      serviceDate: '2026-01-04',
      reviewerRef: 'ai:model-sim',
      reviewedAt: AT,
      origin: {
        kind: 'suggestion-accepted',
        suggestionId: s.suggestionId,
        provenance: s.provenance,
      },
    } satisfies ReviewedCode;
    expect(() => claims.attachReviewedCode(smuggled)).toThrow(/human reviewer action/);
  });

  it('minted codes cannot be edited after review', async () => {
    const { worklist, item } = await suggested();
    const [code] = worklist.review('wl-1', acceptAll(item));
    expect(Object.isFrozen(code)).toBe(true);
    expect(() => {
      (code as { code: string }).code = '99215';
    }).toThrow(TypeError);
  });

  it('attach before review is refused in every pre-review state', async () => {
    const { worklist, claims } = harness({ 'enc-1': SUGGEST_THREE });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    expect(() => worklist.attach('wl-1', claims, AT, ATTACH_ACTOR)).toThrow(/must be reviewed/);
    await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    expect(worklist.item('wl-1').state).toBe('awaiting-review');
    expect(() => worklist.attach('wl-1', claims, AT, ATTACH_ACTOR)).toThrow(/must be reviewed/);
    expect(claims.lines('clm-1')).toHaveLength(0);
  });
});

describe('WP-087 reviewer identity comes from the directory (review major 1)', () => {
  it.each([
    ['an unprefixed service principal (router-1)', SESSIONS.router, /this principal is service/],
    ['an AI principal', SESSIONS.ai, /this principal is ai/],
    ['a human in another tenant', SESSIONS.otherTenant, /another tenant/],
    ['a human without a coding role', SESSIONS.noRole, /coder or coding-lead/],
    ['an unknown session', 'sess-nobody', /not authenticated/],
    ['a malformed session', 'bad session', /must be a token/],
  ])('refuses %s and mints nothing', async (_label, session, message) => {
    const { worklist, claims, item } = await suggested();
    expect(() => worklist.review('wl-1', acceptAll(item, session))).toThrow(message);
    expect(worklist.item('wl-1').state).toBe('awaiting-review');
    expect(() => worklist.attach('wl-1', claims, REVIEW_AT, ATTACH_ACTOR)).toThrow(
      /must be reviewed/,
    );
  });

  it('refuses a human reviewer who requested the suggestions for the item', async () => {
    const { worklist } = harness({ 'enc-1': SUGGEST_THREE });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: REQUESTER_REF, at: AT });
    expect(() => worklist.review('wl-1', acceptAll(item, SESSIONS.requester))).toThrow(
      /queued or requested/,
    );
    expect(worklist.review('wl-1', acceptAll(item, SESSIONS.coder))).toHaveLength(3);
  });

  it('refuses a human reviewer who queued the item', async () => {
    const { worklist } = harness({ 'enc-1': SUGGEST_THREE });
    worklist.enqueue(itemInput(1), AT, REQUESTER_REF);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    expect(() => worklist.review('wl-1', acceptAll(item, SESSIONS.requester))).toThrow(
      /queued or requested/,
    );
  });

  it('refuses a principal whose ref is the model binding, even if the directory calls it human', async () => {
    const gateway = createModelSimCodingGateway({ 'enc-1': SUGGEST_THREE });
    const directory = reviewerDirectory([
      {
        sessionRef: 'sess-mislabelled',
        principalRef: gateway.pin.modelRef,
        tenantId: TENANT,
        kind: 'human',
        roles: ['coder'],
      },
    ]);
    const worklist = new CodingWorklist(gateway, { engaged: () => false }, directory);
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    expect(() => worklist.review('wl-1', acceptAll(item, 'sess-mislabelled'))).toThrow(
      /cannot review its own/,
    );
  });
});

describe('WP-087 no state regression from late or concurrent answers (review major 2)', () => {
  function heldGateway() {
    const sim = createModelSimCodingGateway({ 'enc-1': SUGGEST_THREE });
    const gate = deferred<undefined>();
    let calls = 0;
    const gateway: CodingGatewayPort = {
      pin: sim.pin,
      async invoke(request) {
        calls += 1;
        if (calls === 1) {
          return {
            kind: 'blocked',
            interactionRef: request.interactionRef,
            reason: 'provider-failed',
          };
        }
        await gate.promise;
        return sim.invoke(request);
      },
      readOutput: (tenantId, outputRef, outputHash) =>
        sim.readOutput(tenantId, outputRef, outputHash),
    };
    return { gateway, release: () => gate.resolve(undefined) };
  }

  it('a gateway answer that lands after review and attach is discarded, and the item stays attached', async () => {
    const { gateway, release } = heldGateway();
    const { claims } = harness({});
    const worklist = new CodingWorklist(gateway, { engaged: () => false }, reviewerDirectory());
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    expect(
      (await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT })).state,
    ).toBe('manual');

    const retry = worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    worklist.review('wl-1', {
      reviewerSessionRef: SESSIONS.coder,
      reviewedAt: REVIEW_AT,
      decisions: [],
      manualCodes: [{ system: 'CPT', code: '99213', units: 1 }],
    });
    worklist.attach('wl-1', claims, REVIEW_AT, ATTACH_ACTOR);
    release();
    const late = await retry;

    expect(late.state).toBe('attached');
    expect(late.suggestions).toHaveLength(0);
    expect(worklist.item('wl-1').state).toBe('attached');
    expect(() =>
      worklist.review('wl-1', {
        reviewerSessionRef: SESSIONS.coder,
        reviewedAt: REVIEW_AT,
        decisions: [],
        manualCodes: [],
      }),
    ).toThrow(/not open in state attached/);
    expect(worklist.events('wl-1').map((e) => e.kind)).toContain('late-result-discarded');
    expect(claims.lines('clm-1')).toHaveLength(1);
  });

  it('refuses a second request for an item while one is in flight', async () => {
    const { gateway, release } = heldGateway();
    const worklist = new CodingWorklist(gateway, { engaged: () => false }, reviewerDirectory());
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    const first = worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    await expect(
      worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT }),
    ).rejects.toThrow(/already in flight/);
    release();
    expect((await first).state).toBe('awaiting-review');
    // The lock is released: a later request is judged on state alone.
    await expect(
      worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT }),
    ).rejects.toThrow(/cannot be requested in state awaiting-review/);
  });

  it('reviewed code ids are unique across items and reviews', async () => {
    const { worklist } = harness({ 'enc-1': SUGGEST_THREE, 'enc-2': SUGGEST_THREE });
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    worklist.enqueue(itemInput(2), AT, SERVICE_ACTOR);
    const a = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    const b = await worklist.requestSuggestions('wl-2', { actorRef: SERVICE_ACTOR, at: AT });
    const ids = [
      ...worklist.review('wl-1', acceptAll(a)),
      ...worklist.review('wl-2', acceptAll(b)),
    ].map((c) => c.reviewedCodeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('wl-1:V1:R1');
    expect(ids[3]).toBe('wl-2:V2:R1');
  });
});

describe('WP-087 kill switch quarantines AI output (review minor)', () => {
  it('engaging it while a request is in flight turns the answer into manual', async () => {
    const sim = createModelSimCodingGateway({ 'enc-1': SUGGEST_THREE });
    const kill = killSwitch(false);
    const gateway: CodingGatewayPort = {
      pin: sim.pin,
      async invoke(request) {
        const decision = await sim.invoke(request);
        kill.engagedNow = true;
        return decision;
      },
      readOutput: (t, r, h) => sim.readOutput(t, r, h),
    };
    const worklist = new CodingWorklist(gateway, kill, reviewerDirectory());
    worklist.enqueue(itemInput(1), AT, SERVICE_ACTOR);
    const item = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    expect(item.state).toBe('manual');
    expect(item.manualReason).toBe('kill-switch');
    expect(item.suggestions).toHaveLength(0);
  });

  it('engaging it before review withdraws the suggestions and refuses the AI-based review', async () => {
    const { kill, worklist, item } = await suggested();
    kill.engagedNow = true;
    expect(() => worklist.review('wl-1', acceptAll(item))).toThrow(/kill switch is engaged/);
    const now = worklist.item('wl-1');
    expect([now.state, now.manualReason, now.suggestions.length]).toEqual([
      'manual',
      'kill-switch',
      0,
    ]);
    // The human can still code the item by hand.
    expect(
      worklist.review('wl-1', {
        reviewerSessionRef: SESSIONS.coder,
        reviewedAt: REVIEW_AT,
        decisions: [],
        manualCodes: [{ system: 'CPT', code: '99213', units: 1 }],
      }),
    ).toHaveLength(1);
  });

  it('engaging it after review revokes AI-origin codes before they reach a claim', async () => {
    const { kill, worklist, claims, item } = await suggested();
    const codes = worklist.review('wl-1', acceptAll(item));
    kill.engagedNow = true;
    expect(() => worklist.attach('wl-1', claims, REVIEW_AT, ATTACH_ACTOR)).toThrow(
      /kill switch is engaged/,
    );
    expect(codes.every((c) => !codingApi.isReviewerMinted(c))).toBe(true);
    const first = codes[0];
    if (first === undefined) throw new Error('fixture');
    expect(() => claims.attachReviewedCode(first)).toThrow(/human reviewer action/);
    expect(claims.lines('clm-1')).toHaveLength(0);
    expect(worklist.item('wl-1').state).toBe('manual');
  });

  it('quarantine() sweeps every open AI item of the tenant and leaves attached ones alone', async () => {
    const { kill, worklist, claims } = harness({
      'enc-1': SUGGEST_THREE,
      'enc-2': SUGGEST_THREE,
      'enc-3': SUGGEST_THREE,
    });
    for (const n of [1, 2, 3]) worklist.enqueue(itemInput(n), AT, SERVICE_ACTOR);
    const one = await worklist.requestSuggestions('wl-1', { actorRef: SERVICE_ACTOR, at: AT });
    const two = await worklist.requestSuggestions('wl-2', { actorRef: SERVICE_ACTOR, at: AT });
    await worklist.requestSuggestions('wl-3', { actorRef: SERVICE_ACTOR, at: AT });
    worklist.review('wl-1', acceptAll(one));
    worklist.attach('wl-1', claims, REVIEW_AT, ATTACH_ACTOR);
    worklist.review('wl-2', acceptAll(two));
    kill.engagedNow = true;
    expect(worklist.quarantine(TENANT, REVIEW_AT, 'ai-governance-console')).toEqual([
      'wl-2',
      'wl-3',
    ]);
    expect(worklist.item('wl-1').state).toBe('attached');
    expect(worklist.events('wl-2').at(-1)).toMatchObject({
      kind: 'quarantined',
      actorRef: 'ai-governance-console',
    });
  });
});

describe('WP-087 structural source scan over all of modules/rcm/src (review minor)', () => {
  const real = rcmSourceFiles();

  it('the real tree has no violations, and the scan reads beyond coding/', () => {
    expect(real.some((f) => f.path === 'coding/worklist.ts')).toBe(true);
    expect(real.some((f) => !f.path.startsWith('coding/'))).toBe(true);
    expect(real.length).toBeGreaterThan(10);
    expect(scanNoAutonomy(real)).toEqual([]);
  });

  it('the mint is not in the public API', () => {
    expect(Object.keys(codingApi)).not.toContain('mintReviewedCode');
    expect(Object.keys(codingApi)).not.toContain('revokeReviewedCode');
  });

  const plant = (file: SourceFile) => scanNoAutonomy([...real, file]);
  const replace = (path: string, edit: (text: string) => string) =>
    scanNoAutonomy(real.map((f) => (f.path === path ? { ...f, text: edit(f.text) } : f)));

  it.each([
    [
      'a new coding file calling the mint',
      {
        path: 'coding/auto.ts',
        text: "import { mintReviewedCode } from './review-mint.js';\nmintReviewedCode(x);",
      },
      /references the mint outside/,
    ],
    [
      'an aliased import in another coding file',
      {
        path: 'coding/alias.ts',
        text: "import { mintReviewedCode as m } from './review-mint.js';\nm(x);",
      },
      /references the mint outside/,
    ],
    [
      'a caller outside coding/',
      {
        path: 'claims/autocode.ts',
        text: "import { mintReviewedCode } from '../coding/review-mint.js';\nmintReviewedCode(x);",
      },
      /claims\/autocode.ts: references the mint/,
    ],
    [
      'a namespace import',
      {
        path: 'claims/ns.ts',
        text: "import * as mint from '../coding/review-mint.js';\nmint.isReviewerMinted(x);",
      },
      /namespace import/,
    ],
    [
      'a dynamic import',
      { path: 'claims/dyn.ts', text: "const m = await import('../coding/review-mint.js');" },
      /dynamic import/,
    ],
    [
      'a star re-export',
      { path: 'coding/reexport.ts', text: "export * from './review-mint.js';" },
      /star re-export/,
    ],
    [
      'a claim-port call outside attach',
      { path: 'claims/push.ts', text: 'port.attachReviewedCode(code);' },
      /claim port outside/,
    ],
  ])('control: catches %s', (_label, file, message) => {
    const violations = plant(file);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('\n')).toMatch(message);
  });

  it('control: catches a mint call moved outside review() inside worklist.ts', () => {
    const violations = replace('coding/worklist.ts', (t) =>
      t.replace(
        '  private killed(tenantId: string): boolean {',
        '  private sneak(): void { mintReviewedCode(x); }\n  private killed(tenantId: string): boolean {',
      ),
    );
    expect(violations).toEqual(['coding/worklist.ts: mints outside review()']);
  });

  it('control: catches an aliased mint import inside worklist.ts', () => {
    const violations = replace('coding/worklist.ts', (t) =>
      t.replace(
        'import { mintReviewedCode, revokeReviewedCode }',
        'import { mintReviewedCode as m, revokeReviewedCode }',
      ),
    );
    expect(violations).toContain('coding/worklist.ts: aliases the mint');
  });

  // H-17 (NR-126): the three mutants that survived the attempt-2 scan.
  const killed = 'private killed(tenantId: string): boolean {';

  it('H-17 m6: catches a value re-export of the mint from worklist.ts called from src/claims', () => {
    expect(real.some((f) => f.path === 'coding/worklist.ts' && f.text.includes(killed))).toBe(true);
    const withReExport = real.map((f) =>
      f.path === 'coding/worklist.ts'
        ? { ...f, text: `${f.text}\nexport const issueCode = mintReviewedCode;\n` }
        : f,
    );
    const violations = scanNoAutonomy([
      ...withReExport,
      {
        path: 'claims/leak.ts',
        text: "import { issueCode } from '../coding/worklist.js';\nissueCode(x);",
      },
    ]);
    expect(violations).toContain('coding/worklist.ts: mints outside review()');
  });

  it('H-17 m7: catches .call / .apply / .bind indirection of the mint', () => {
    for (const form of [
      'mintReviewedCode.call(undefined, c)',
      'mintReviewedCode.apply(undefined, [c])',
      'mintReviewedCode.bind(undefined)(c)',
    ]) {
      const violations = replace('coding/worklist.ts', (t) =>
        t.replace(killed, `private sneak(c: never): void { ${form}; }\n  ${killed}`),
      );
      expect(violations, form).toContain('coding/worklist.ts: mints outside review()');
      expect(violations, form).toContain('coding/worklist.ts: indirect call of the mint');
    }
    const revoke = replace('coding/worklist.ts', (t) =>
      t.replace(
        killed,
        `private sneak(c: never): void { revokeReviewedCode.call(undefined, c); }\n  ${killed}`,
      ),
    );
    expect(revoke).toContain('coding/worklist.ts: revokes outside quarantineIfKilled()');
  });

  it('H-17 m8: a production file named *test-support* is scanned, and production cannot import test support', () => {
    expect(real.some((f) => f.path === 'coding/fixtures.test-support.ts')).toBe(true);
    const misnamed = plant({
      path: 'claims/helper.test-support.ts',
      text: "import { mintReviewedCode } from '../coding/review-mint.js';\nexport const helper = (c: never) => mintReviewedCode(c);",
    });
    expect(misnamed).toContain(
      'claims/helper.test-support.ts: references the mint outside the worklist',
    );
    const importer = plant({
      path: 'claims/uses-helper.ts',
      text: "import { helper } from './helper.test-support.js';\nhelper(x);",
    });
    expect(importer).toContain(
      'claims/uses-helper.ts: production file imports a test-support module',
    );
  });
});
