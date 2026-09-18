export type ConsentState = 'granted' | 'denied' | 'unknown';

export interface RecordingConsentRecord {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly purpose: 'results-release' | 'chart-delta';
  readonly state: ConsentState;
  readonly synthetic: true;
}

export function assertRecordingConsent(record: RecordingConsentRecord): void {
  if (record.synthetic !== true) throw new Error('WP061_NON_SYNTHETIC');
  if (record.state !== 'granted') throw new Error(`WP061_CONSENT_NOT_GRANTED:${record.state}`);
}
