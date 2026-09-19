import { CertError, type DrillResult } from './contracts.js';

export function assertNoSampleDown(emergencySessions: number, reviewedSessions: number): void {
  if (emergencySessions === 0) {
    throw new CertError('NO_EMERGENCY_SAMPLE', 'empty');
  }
  if (reviewedSessions < emergencySessions) {
    throw new CertError('SAMPLE_DOWN', `${reviewedSessions}/${emergencySessions}`);
  }
}

export function packPassed(drills: readonly DrillResult[], sampledDown: boolean): boolean {
  return sampledDown !== true && drills.every((drill) => drill.passed);
}
