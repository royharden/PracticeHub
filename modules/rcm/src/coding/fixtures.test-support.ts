import { createHash } from 'node:crypto';

import { wp086PlaceholderClaimPort } from './claim-placeholder.js';
import type { CodingKillSwitchPort } from './gateway-port.js';
import { createModelSimCodingGateway, type ModelSimScript } from './model-sim.js';
import { wp014PlaceholderReviewerDirectory, type Wp014SessionSeed } from './reviewer-directory.js';
import type { WorklistItemInput } from './types.js';
import { CodingWorklist } from './worklist.js';

export const TENANT = 'tenant-synth-01';
export const AT = '2026-01-05T10:00:00Z';
export const REVIEW_AT = '2026-01-05T11:00:00Z';
export const SERVICE_ACTOR = 'svc:rcm-coding';
export const ATTACH_ACTOR = 'rcm-billing-svc';

/** Authenticated sessions the placeholder directory knows. Only the directory says who is human. */
export const SESSIONS = {
  coder: 'sess-coder-07',
  lead: 'sess-lead-02',
  router: 'sess-router-1',
  ai: 'sess-model-sim',
  otherTenant: 'sess-coder-other',
  noRole: 'sess-frontdesk-3',
  requester: 'sess-coder-requester',
} as const;

export const CODER_REF = 'coder-synth-07';
export const REQUESTER_REF = 'coder-synth-11';

const SEEDS: readonly Wp014SessionSeed[] = [
  {
    sessionRef: SESSIONS.coder,
    principalRef: CODER_REF,
    tenantId: TENANT,
    kind: 'human',
    roles: ['coder'],
  },
  {
    sessionRef: SESSIONS.lead,
    principalRef: 'lead-synth-02',
    tenantId: TENANT,
    kind: 'human',
    roles: ['coding-lead'],
  },
  {
    sessionRef: SESSIONS.router,
    principalRef: 'router-1',
    tenantId: TENANT,
    kind: 'service',
    roles: ['coder'],
  },
  {
    sessionRef: SESSIONS.ai,
    principalRef: 'model-sim:coding',
    tenantId: TENANT,
    kind: 'ai',
    roles: ['coder'],
  },
  {
    sessionRef: SESSIONS.otherTenant,
    principalRef: 'coder-synth-99',
    tenantId: 'tenant-synth-02',
    kind: 'human',
    roles: ['coder'],
  },
  {
    sessionRef: SESSIONS.noRole,
    principalRef: 'frontdesk-synth-3',
    tenantId: TENANT,
    kind: 'human',
    roles: ['front-desk'],
  },
  {
    sessionRef: SESSIONS.requester,
    principalRef: REQUESTER_REF,
    tenantId: TENANT,
    kind: 'human',
    roles: ['coder'],
  },
];

export function reviewerDirectory(extra: readonly Wp014SessionSeed[] = []) {
  return wp014PlaceholderReviewerDirectory([...SEEDS, ...extra]);
}

export function docHash(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

export function itemInput(
  n: number,
  overrides: Partial<WorklistItemInput> = {},
): WorklistItemInput {
  return {
    itemId: `wl-${String(n)}`,
    tenantId: TENANT,
    encounterId: `enc-${String(n)}`,
    claimId: `clm-${String(n)}`,
    documentationRef: `doc-${String(n)}`,
    documentationHash: docHash(`synthetic note ${String(n)}`),
    serviceDate: '2026-01-04',
    ...overrides,
  };
}

export const SUGGEST_THREE: ModelSimScript = {
  kind: 'suggest',
  body: JSON.stringify({
    suggestions: [
      {
        system: 'CPT',
        code: '99214',
        units: 1,
        rationale: 'synthetic established visit',
        confidence: 0.82,
      },
      {
        system: 'ICD-10-CM',
        code: 'E11.9',
        units: 1,
        rationale: 'synthetic diabetes note',
        confidence: 0.9,
      },
      {
        system: 'CPT',
        code: '36415',
        units: 1,
        rationale: 'synthetic venipuncture',
        confidence: 0.4,
      },
    ],
    synthetic: true,
  }),
};

export function killSwitch(engaged = false): CodingKillSwitchPort & { engagedNow: boolean } {
  const port = {
    engagedNow: engaged,
    engaged(): boolean {
      return port.engagedNow;
    },
  };
  return port;
}

export function harness(
  scripts: Readonly<Record<string, ModelSimScript>>,
  options: { killed?: boolean; claimState?: 'draft' | 'validated' | 'submitted' } = {},
) {
  const gateway = createModelSimCodingGateway(scripts);
  const kill = killSwitch(options.killed ?? false);
  const worklist = new CodingWorklist(gateway, kill, reviewerDirectory());
  const claims = wp086PlaceholderClaimPort(
    [1, 2, 3, 4, 5].map((n) => ({
      claimId: `clm-${String(n)}`,
      tenantId: TENANT,
      state: options.claimState ?? 'draft',
    })),
  );
  return { gateway, kill, worklist, claims };
}

/** A deferred promise, to hold a gateway answer until a test releases it. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
