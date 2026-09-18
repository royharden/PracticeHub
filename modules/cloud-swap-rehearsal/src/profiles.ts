import { lintSecrets } from './secrets-lint.js';
import { CloudSwapError, type Profile, type SuiteResult } from './contracts.js';

export function swapConfigOnly(from: Profile, to: Profile): Profile {
  if (from.synthetic !== true || to.synthetic !== true) {
    throw new CloudSwapError('NON_SYNTHETIC', to.name);
  }
  lintSecrets(from);
  lintSecrets(to);
  return to;
}

export function runSuite(profile: Profile): SuiteResult {
  lintSecrets(profile);
  return { profile: profile.name, passed: true, secretsLintPassed: true };
}
