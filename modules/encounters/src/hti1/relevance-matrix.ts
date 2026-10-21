/**
 * §170.315 relevance matrix and certification decision (WP-096; R6-REQ-040/041).
 *
 * Certification posture is a documented, revisitable decision, never a gate:
 * the decision record carries `blocksBilling: false` as a literal type. Each
 * relied-upon capability maps to criteria, and each criterion is either
 * provided by a named certified component or recorded as an owned-UI gap.
 * Rows are synthetic reference data pending counsel review.
 */

export const reliedUponCapabilities = [
  'e-prescribing',
  'ccda-uscdi-export',
  'patient-access',
  'decision-support-interventions',
] as const;
export type ReliedUponCapability = (typeof reliedUponCapabilities)[number];

export type CriterionRelevance =
  | { readonly kind: 'certified-component'; readonly component: string }
  | { readonly kind: 'owned-ui-gap'; readonly gapOwner: string; readonly note: string }
  | { readonly kind: 'not-relied-upon'; readonly rationale: string };

export interface CriterionRow {
  readonly criterion: string;
  readonly title: string;
  readonly capability: ReliedUponCapability | null;
  readonly relevance: CriterionRelevance;
  readonly synthetic: true;
}

export const relevanceMatrixV1: readonly CriterionRow[] = [
  {
    criterion: '170.315(b)(3)',
    title: 'Electronic prescribing',
    capability: 'e-prescribing',
    relevance: { kind: 'certified-component', component: 'erx-network-simulator' },
    synthetic: true,
  },
  {
    criterion: '170.315(b)(1)',
    title: 'Transitions of care',
    capability: 'ccda-uscdi-export',
    relevance: { kind: 'certified-component', component: 'medplum-hosted' },
    synthetic: true,
  },
  {
    criterion: '170.315(b)(10)',
    title: 'Electronic health information export',
    capability: 'ccda-uscdi-export',
    relevance: { kind: 'certified-component', component: 'medplum-hosted' },
    synthetic: true,
  },
  {
    criterion: '170.315(e)(1)',
    title: 'View, download, and transmit to 3rd party',
    capability: 'patient-access',
    relevance: {
      kind: 'owned-ui-gap',
      gapOwner: 'portal',
      note: 'owned portal UI is not certified; access path is planned without certification',
    },
    synthetic: true,
  },
  {
    criterion: '170.315(g)(10)',
    title: 'Standardized API for patient and population services',
    capability: 'patient-access',
    relevance: { kind: 'certified-component', component: 'medplum-hosted' },
    synthetic: true,
  },
  {
    criterion: '170.315(b)(11)',
    title: 'Decision support interventions',
    capability: 'decision-support-interventions',
    relevance: {
      kind: 'owned-ui-gap',
      gapOwner: 'ai-governance',
      note: 'predictive DSI source attributes rendered by the encounters hti1 pack',
    },
    synthetic: true,
  },
  {
    criterion: '170.315(a)(1)',
    title: 'CPOE - medications',
    capability: null,
    relevance: { kind: 'not-relied-upon', rationale: 'orders are placed in the athena authority' },
    synthetic: true,
  },
];

export interface CertificationDecision {
  readonly decisionRef: string;
  readonly posture: 'no-owned-certification' | 'certify-owned-module';
  readonly blocksBilling: false;
  readonly rationale: string;
  readonly revisitTriggers: readonly string[];
  readonly providerCount: number;
  readonly synthetic: true;
}

/** PI reweighting status is a displayed metric (<15 providers), not a blocker. */
export function promotingInteroperabilityStatus(
  decision: CertificationDecision,
): 'auto-reweighted' | 'reporting-required' {
  return decision.providerCount < 15 ? 'auto-reweighted' : 'reporting-required';
}

export interface MatrixFinding {
  readonly criterion: string | null;
  readonly problem: string;
}

/** Completeness: every relied-upon capability is covered; every row resolves. */
export function checkMatrixCompleteness(
  rows: readonly CriterionRow[],
  decision: CertificationDecision,
): readonly MatrixFinding[] {
  const findings: MatrixFinding[] = [];
  for (const capability of reliedUponCapabilities) {
    if (
      !rows.some((row) => row.capability === capability && row.relevance.kind !== 'not-relied-upon')
    ) {
      findings.push({ criterion: null, problem: `capability ${capability} maps to no criterion` });
    }
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.criterion)) {
      findings.push({ criterion: row.criterion, problem: 'duplicate criterion row' });
    }
    seen.add(row.criterion);
    const r = row.relevance;
    const empty =
      (r.kind === 'certified-component' && r.component.trim() === '') ||
      (r.kind === 'owned-ui-gap' && (r.gapOwner.trim() === '' || r.note.trim() === '')) ||
      (r.kind === 'not-relied-upon' && r.rationale.trim() === '');
    if (empty) {
      findings.push({ criterion: row.criterion, problem: `${r.kind} row is missing its mapping` });
    }
    if (row.capability !== null && r.kind === 'not-relied-upon') {
      findings.push({
        criterion: row.criterion,
        problem: 'a relied-upon capability row cannot be not-relied-upon',
      });
    }
  }
  if (decision.rationale.trim() === '' || decision.revisitTriggers.length === 0) {
    findings.push({
      criterion: null,
      problem: 'certification decision needs a rationale and revisit triggers',
    });
  }
  return findings;
}
