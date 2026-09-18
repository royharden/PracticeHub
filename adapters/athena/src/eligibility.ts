export type EligibilityVerdict = 'eligible' | 'fail-visible';

export function eligibilityFailVisible(apiDown: boolean, stale: boolean): EligibilityVerdict {
  if (apiDown || stale) return 'fail-visible';
  return 'eligible';
}
