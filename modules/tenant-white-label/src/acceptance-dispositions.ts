export interface WhiteLabelDispositionRow {
  readonly requirementId: string;
  readonly clause: string;
  readonly disposition: 'ENCODE';
  readonly owners: readonly string[];
  readonly evidence: readonly string[];
}

export const whiteLabelDispositionLedger: readonly WhiteLabelDispositionRow[] = [
  {
    requirementId: 'REQ-WL-001',
    clause: 'AC1',
    disposition: 'ENCODE',
    owners: ['WP-126'],
    evidence: [
      'fixtures/REQ-WL-001.HAPPY.json',
      'fixtures/REQ-WL-001.BOUNDARY.json',
      'fixtures/REQ-WL-001.FAILURE.json',
      'fixtures/REQ-WL-001.RECOVERY.json',
    ],
  },
];
