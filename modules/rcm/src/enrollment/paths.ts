import { RcmShadowError } from '../contracts.js';

/**
 * Simulated transaction paths known to WP-091. `ch-sim-A` and `ch-sim-B` are the WP-085
 * clearinghouse rails; `payerportal-sim` is RAIL-017; `availity-sim` is the named third
 * eligibility path (Availity-class). EW-CH-01 stays an external wait: every path is simulated.
 */
export type PathId = 'ch-sim-A' | 'ch-sim-B' | 'payerportal-sim' | 'availity-sim';

export const PATH_IDS: readonly PathId[] = [
  'ch-sim-A',
  'ch-sim-B',
  'payerportal-sim',
  'availity-sim',
];

export type PathKind = 'clearinghouse' | 'payer-portal' | 'eligibility-supplement';

/** Transactions tracked independently per payer x path (REQ-PLAT-012 AC-1). */
export type EnrollmentTransaction = '270/271' | '837' | '999' | '277CA' | '276/277' | '835' | '275';

export const ENROLLMENT_TRANSACTIONS: readonly EnrollmentTransaction[] = [
  '270/271',
  '837',
  '999',
  '277CA',
  '276/277',
  '835',
  '275',
];

export interface PathDescriptor {
  readonly pathId: PathId;
  readonly kind: PathKind;
  /** Upstream carriers/networks the path depends on. Logo diversity is not failure-mode diversity. */
  readonly upstreams: readonly string[];
  readonly transactions: readonly EnrollmentTransaction[];
  readonly simulated: true;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Default synthetic catalog. Upstream names are synthetic labels, not vendors. */
export const DEFAULT_PATH_CATALOG: readonly PathDescriptor[] = [
  {
    pathId: 'ch-sim-A',
    kind: 'clearinghouse',
    upstreams: ['upstream-sim-alpha'],
    transactions: ['270/271', '837', '999', '277CA', '276/277', '835', '275'],
    simulated: true,
  },
  {
    pathId: 'ch-sim-B',
    kind: 'clearinghouse',
    upstreams: ['upstream-sim-beta'],
    transactions: ['270/271', '837', '999', '277CA', '835'],
    simulated: true,
  },
  {
    pathId: 'payerportal-sim',
    kind: 'payer-portal',
    upstreams: ['payer-direct-sim'],
    transactions: ['270/271'],
    simulated: true,
  },
  {
    pathId: 'availity-sim',
    kind: 'eligibility-supplement',
    upstreams: ['upstream-sim-gamma'],
    transactions: ['270/271', '276/277'],
    simulated: true,
  },
];

export class PathCatalog {
  private readonly byId = new Map<PathId, PathDescriptor>();

  public constructor(descriptors: readonly PathDescriptor[] = DEFAULT_PATH_CATALOG) {
    for (const descriptor of descriptors) {
      if (!PATH_IDS.includes(descriptor.pathId)) {
        throw new RcmShadowError('PATH_UNKNOWN', 'path id is not a known simulated path');
      }
      if (this.byId.has(descriptor.pathId)) {
        throw new RcmShadowError('PATH_DUPLICATE', 'path id must be unique in a catalog');
      }
      if (
        descriptor.upstreams.length === 0 ||
        !descriptor.upstreams.every((up) => TOKEN.test(up))
      ) {
        throw new RcmShadowError(
          'PATH_UPSTREAM',
          'a path must declare at least one token upstream',
        );
      }
      if (descriptor.simulated !== true) {
        throw new RcmShadowError('PATH_LIVE', 'EW-CH-01 is open: only simulated paths are allowed');
      }
      this.byId.set(descriptor.pathId, descriptor);
    }
  }

  public get(pathId: PathId): PathDescriptor {
    const descriptor = this.byId.get(pathId);
    if (!descriptor) {
      throw new RcmShadowError('PATH_UNKNOWN', 'path is not in the catalog');
    }
    return descriptor;
  }

  public supports(pathId: PathId, transaction: EnrollmentTransaction): boolean {
    return this.get(pathId).transactions.includes(transaction);
  }

  public all(): readonly PathDescriptor[] {
    return [...this.byId.values()];
  }
}
