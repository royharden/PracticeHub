export const leftoverCommIds = [
  'REQ-COMM-005',
  'REQ-COMM-006',
  'REQ-COMM-007',
  'REQ-COMM-014',
  'REQ-COMM-015',
  'REQ-COMM-024',
] as const;

export const rehearsalDispositionLedger = leftoverCommIds.map((requirementId) => ({
  requirementId,
  clause: 'AC1',
  disposition: 'ENCODE' as const,
  owners: ['WP-130'] as const,
  evidence: [
    `fixtures/${requirementId}.HAPPY.json`,
    `fixtures/${requirementId}.BOUNDARY.json`,
    `fixtures/${requirementId}.FAILURE.json`,
    `fixtures/${requirementId}.RECOVERY.json`,
  ],
}));
