export const REHEARSAL_IDENTITY = 'WP-125/CLOUD-SWAP';

export class CloudSwapError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloudSwapError';
  }
}

export interface Profile {
  readonly name: 'staging' | 'cloud-shaped';
  readonly region: string;
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly inlineSecrets: Readonly<Record<string, string>>;
  readonly synthetic: true;
}

export interface SuiteResult {
  readonly profile: Profile['name'];
  readonly passed: boolean;
  readonly secretsLintPassed: boolean;
}
