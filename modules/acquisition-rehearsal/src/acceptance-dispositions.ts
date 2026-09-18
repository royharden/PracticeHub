export type RehearsalDisposition = 'ENCODE' | 'FORWARD-WHOLE';

export interface RehearsalDispositionRow {
  readonly requirementId: string;
  readonly clause: string;
  readonly disposition: RehearsalDisposition;
  readonly owners: readonly string[];
  readonly fwdId: string | null;
  readonly evidence: readonly string[];
}

export const rehearsalDispositionLedger: readonly RehearsalDispositionRow[] = [
  {
    requirementId: 'REQ-MIG-018',
    clause: 'AC1',
    disposition: 'ENCODE',
    owners: ['WP-117'],
    fwdId: null,
    evidence: [
      'fixtures/REQ-MIG-018.HAPPY.json',
      'fixtures/REQ-MIG-018.BOUNDARY.json',
      'fixtures/REQ-MIG-018.FAILURE.json',
      'fixtures/REQ-MIG-018.RECOVERY.json',
    ],
  },
  {
    requirementId: 'REQ-MIG-019',
    clause: 'AC1',
    disposition: 'ENCODE',
    owners: ['WP-117'],
    fwdId: null,
    evidence: [
      'fixtures/REQ-MIG-019.HAPPY.json',
      'fixtures/REQ-MIG-019.BOUNDARY.json',
      'fixtures/REQ-MIG-019.FAILURE.json',
      'fixtures/REQ-MIG-019.RECOVERY.json',
    ],
  },
];
