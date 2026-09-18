export type Disposition = 'encoded' | 'forwarded' | 'blocked';

export interface AcceptanceDisposition {
  requirement: string;
  disposition: Disposition;
  evidence: string;
}

export interface ClauseDisposition extends AcceptanceDisposition {
  clause: `${string}.${'AC' | 'EX'}${number}`;
}

function clauses(
  requirement: string,
  clauseIds: readonly `${'AC' | 'EX'}${number}`[],
  disposition: Disposition,
  evidence: string,
): ClauseDisposition[] {
  return clauseIds.map((clauseId) => ({
    requirement,
    clause: `${requirement}.${clauseId}`,
    disposition,
    evidence,
  }));
}

export const WP040_ACCEPTANCE_DISPOSITIONS: readonly AcceptanceDisposition[] = [
  {
    requirement: 'REQ-SCH-001',
    disposition: 'forwarded',
    evidence: 'versioned constraint-provider integration',
  },
  {
    requirement: 'REQ-SCH-002',
    disposition: 'encoded',
    evidence: 'scoped hold, commit, idempotency, and reconciliation core',
  },
  {
    requirement: 'REQ-SCH-003',
    disposition: 'forwarded',
    evidence: 'original safety encoded; channel confirmation forwarded',
  },
  {
    requirement: 'REQ-SCH-006',
    disposition: 'forwarded',
    evidence: 'multi-party resource orchestration',
  },
  {
    requirement: 'REQ-SCH-007',
    disposition: 'forwarded',
    evidence: 'cross-location exclusion encoded; travel and privilege workflow forwarded',
  },
  {
    requirement: 'REQ-SCH-015',
    disposition: 'forwarded',
    evidence: 'interpreter and accessibility resource integration',
  },
  {
    requirement: 'REQ-SCH-017',
    disposition: 'forwarded',
    evidence: 'clinical-authority incident workflow',
  },
  {
    requirement: 'REQ-SCH-018',
    disposition: 'forwarded',
    evidence: 'clinical prerequisite revalidation integration',
  },
  {
    requirement: 'REQ-SCH-019',
    disposition: 'forwarded',
    evidence: 'safe replacement encoded; priority repair forwarded',
  },
  {
    requirement: 'REQ-SCH-020',
    disposition: 'forwarded',
    evidence: 'payer and directory acceptance evidence',
  },
  {
    requirement: 'REQ-SCH-021',
    disposition: 'forwarded',
    evidence: 'same-day candidate and multi-offer workflow',
  },
  {
    requirement: 'REQ-SCH-022',
    disposition: 'forwarded',
    evidence: 'expired-offer and deliverability workflow',
  },
  {
    requirement: 'REQ-SCH-028',
    disposition: 'forwarded',
    evidence: 'structural core encoded; catalog and alternate-location work forwarded',
  },
  {
    requirement: 'REQ-SCH-031',
    disposition: 'forwarded',
    evidence: 'waitlist, recall, and no-show orchestration',
  },
  {
    requirement: 'REQ-SCH-038',
    disposition: 'forwarded',
    evidence: 'cross-location patient exclusion encoded; travel and sweep work forwarded',
  },
  {
    requirement: 'REQ-SCH-042',
    disposition: 'blocked',
    evidence: 'equipment calibration source and mid-day invalidation unavailable',
  },
];

// Every AC/EX in the assigned slice is explicitly closed, forwarded, or blocked.
// A forwarded clause is not claimed implemented by this provisional scheduling core.
export const WP040_CLAUSE_DISPOSITIONS: readonly ClauseDisposition[] = [
  ...clauses(
    'REQ-SCH-001',
    ['AC1', 'AC2', 'AC3', 'EX1'],
    'forwarded',
    'constraint-provider integration',
  ),
  ...clauses('REQ-SCH-002', ['AC1', 'AC2'], 'encoded', 'hold/commit/idempotency service tests'),
  ...clauses('REQ-SCH-002', ['AC3'], 'forwarded', 'equivalent-options presentation'),
  ...clauses('REQ-SCH-002', ['EX1'], 'encoded', 'indeterminate tombstone and reconciliation'),
  ...clauses(
    'REQ-SCH-003',
    ['AC1', 'AC3', 'EX1'],
    'encoded',
    'original-safe replacement and failure tests',
  ),
  ...clauses('REQ-SCH-003', ['AC2'], 'forwarded', 'preferred-channel confirmation integration'),
  ...clauses(
    'REQ-SCH-006',
    ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'],
    'forwarded',
    'multi-party resource orchestration',
  ),
  ...clauses('REQ-SCH-006', ['EX1'], 'blocked', 'calibration authority dependency'),
  ...clauses('REQ-SCH-006', ['EX2'], 'blocked', 'real Athena/provider parity'),
  ...clauses('REQ-SCH-007', ['AC1'], 'encoded', 'cross-location structural identities'),
  ...clauses(
    'REQ-SCH-007',
    ['AC2', 'AC3', 'AC4', 'AC5', 'AC6'],
    'forwarded',
    'travel/privilege/recovery workflow',
  ),
  ...clauses('REQ-SCH-007', ['EX1'], 'encoded', 'stable exclusive-resource identity'),
  ...clauses(
    'REQ-SCH-007',
    ['EX2', 'EX3'],
    'forwarded',
    'provider roster and identity integration',
  ),
  ...clauses(
    'REQ-SCH-015',
    ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'EX1', 'EX2', 'EX3', 'EX4'],
    'forwarded',
    'accommodation and interpreter provider integration',
  ),
  ...clauses(
    'REQ-SCH-017',
    ['AC1', 'AC2', 'AC3', 'AC4', 'EX1', 'EX2'],
    'forwarded',
    'clinical-authority incident workflow',
  ),
  ...clauses(
    'REQ-SCH-018',
    ['AC1', 'AC2', 'AC3', 'AC4', 'EX2'],
    'forwarded',
    'clinical prerequisite evidence integration',
  ),
  ...clauses('REQ-SCH-018', ['EX1'], 'encoded', 'explicit prerequisite re-evaluation input'),
  ...clauses(
    'REQ-SCH-019',
    ['AC1', 'AC2', 'EX2'],
    'forwarded',
    'versioned priority and clinician workflow',
  ),
  ...clauses(
    'REQ-SCH-019',
    ['AC3', 'EX1'],
    'encoded',
    'replacement-after-hold and prerequisite gate',
  ),
  ...clauses(
    'REQ-SCH-020',
    ['AC1', 'AC2', 'AC3', 'EX1'],
    'forwarded',
    'payer/product evidence integration',
  ),
  ...clauses(
    'REQ-SCH-021',
    ['AC1', 'AC2', 'AC3', 'EX1'],
    'forwarded',
    'candidate ranking, consent, and multi-offer workflow',
  ),
  ...clauses(
    'REQ-SCH-022',
    ['AC1', 'AC2', 'AC3', 'EX1'],
    'forwarded',
    'late-response and deliverability workflow',
  ),
  ...clauses(
    'REQ-SCH-028',
    ['AC3', 'AC8', 'EX1'],
    'encoded',
    'structural multi-resource exclusion',
  ),
  ...clauses(
    'REQ-SCH-028',
    ['AC1', 'AC2', 'AC4', 'AC5', 'AC6', 'AC7', 'EX2', 'EX3', 'EX4'],
    'forwarded',
    'resource catalog, buffers, and alternate-location search',
  ),
  ...clauses(
    'REQ-SCH-031',
    ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8', 'EX1', 'EX2', 'EX3', 'EX4'],
    'forwarded',
    'waitlist/recall/no-show orchestration',
  ),
  ...clauses(
    'REQ-SCH-038',
    ['AC1', 'AC2', 'AC3', 'EX1', 'EX2'],
    'forwarded',
    'travel-buffer, override, UI, and sweep integration',
  ),
  ...clauses(
    'REQ-SCH-042',
    ['AC1', 'AC2', 'AC3', 'AC4', 'EX1', 'EX2'],
    'blocked',
    'real equipment calibration source and WP-032 parity',
  ),
];

export const WP040_INC2_CLAUSE_DISPOSITIONS: readonly ClauseDisposition[] = [
  ...clauses(
    'REQ-SCH-001',
    ['AC1', 'AC2', 'AC3', 'EX1'],
    'encoded',
    'inc2 constraint-provider engine',
  ),
  ...clauses('REQ-SCH-002', ['AC3'], 'encoded', 'inc2 equivalent-options query'),
  ...clauses(
    'REQ-SCH-006',
    ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'],
    'encoded',
    'inc2 multi-resource all-or-none orchestration',
  ),
  ...clauses(
    'REQ-SCH-007',
    ['AC2', 'AC3', 'AC4', 'AC5', 'AC6'],
    'encoded',
    'inc2 cross-location transport/privilege/exception workflow',
  ),
  ...clauses(
    'REQ-SCH-015',
    ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'EX1', 'EX2', 'EX3', 'EX4'],
    'encoded',
    'inc2 interpreter/accessibility resource',
  ),
  ...clauses(
    'REQ-SCH-019',
    ['AC1', 'AC2', 'EX2'],
    'encoded',
    'inc2 waitlist priority pause and restore',
  ),
  ...clauses(
    'REQ-SCH-021',
    ['AC1', 'AC2', 'AC3', 'EX1'],
    'encoded',
    'inc2 same-day backfill ranking',
  ),
  ...clauses(
    'REQ-SCH-022',
    ['AC1', 'AC2', 'EX1'],
    'encoded',
    'inc2 late waitlist acceptance guard',
  ),
  ...clauses(
    'REQ-SCH-028',
    ['AC1', 'AC2', 'AC4', 'AC5', 'AC6', 'AC7', 'EX2', 'EX3', 'EX4'],
    'encoded',
    'inc2 resource catalog, buffers, and alternate location',
  ),
  ...clauses(
    'REQ-SCH-031',
    ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8', 'EX2', 'EX3', 'EX4'],
    'encoded',
    'inc2 waitlist/recall/no-show worklist',
  ),
  ...clauses(
    'REQ-SCH-038',
    ['AC1', 'AC2', 'AC3', 'EX1', 'EX2'],
    'encoded',
    'inc2 cross-location patient overlap and sweep',
  ),
];
