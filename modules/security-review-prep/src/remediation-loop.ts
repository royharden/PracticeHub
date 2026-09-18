export type FindingStatus = 'open' | 'wired' | 'accepted-risk';

export interface SecurityFinding {
  readonly id: string;
  readonly threatId: string;
  readonly workPackageId: string;
  readonly status: FindingStatus;
}

export class RemediationLoopError extends Error {
  public constructor(public readonly code: 'DUPLICATE_FINDING' | 'UNWIRED_PACKAGE' | 'EMPTY_LOOP') {
    super(code);
    this.name = 'RemediationLoopError';
  }
}

const workPackagePattern = /^WP-[0-9]{3}$/;

export class RemediationLoop {
  readonly #findings = new Map<string, SecurityFinding>();

  public wire(finding: SecurityFinding): SecurityFinding {
    if (!workPackagePattern.test(finding.workPackageId)) {
      throw new RemediationLoopError('UNWIRED_PACKAGE');
    }
    if (this.#findings.has(finding.id)) throw new RemediationLoopError('DUPLICATE_FINDING');
    const stored = Object.freeze({ ...finding, status: 'wired' as const });
    this.#findings.set(stored.id, stored);
    return stored;
  }

  public list(): readonly SecurityFinding[] {
    if (this.#findings.size === 0) throw new RemediationLoopError('EMPTY_LOOP');
    return Object.freeze([...this.#findings.values()]);
  }
}
