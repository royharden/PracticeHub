import { assertRecordingConsent, type RecordingConsentRecord } from './recording-consent.js';

export interface ResultsRelease {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly resultId: string;
  readonly visible: boolean;
  readonly synthetic: true;
}

export function releaseResults(consent: RecordingConsentRecord, resultId: string): ResultsRelease {
  assertRecordingConsent(consent);
  return {
    tenantId: consent.tenantId,
    subjectRef: consent.subjectRef,
    resultId,
    visible: true,
    synthetic: true,
  };
}

export function holdResultsWithoutConsent(
  tenantId: string,
  subjectRef: string,
  resultId: string,
): ResultsRelease {
  return { tenantId, subjectRef, resultId, visible: false, synthetic: true };
}
