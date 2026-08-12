/**
 * Surrogate vocabularies and the source register slice (WP-029).
 *
 * synthetic-data-plan §2 names two sourcing tracks. The ACQUISITION track (SSA
 * given-name frequencies, Census surnames, TIGER address geometry, a pinned
 * Synthea release, CMS DE-SynPUF / Synthetic-RIF, NPPES) is an `[EXTERNAL-WAIT]`
 * item — `SRC acquisitions` on the WP-029 row — and none of those files are in
 * this repo. Rather than block, synthgen v1 ships LICENSE-FREE INVENTED
 * surrogates with the same shape, and records in `sourceRegisterV1` exactly
 * which real source each surrogate stands in for and what state that
 * acquisition is in. Swapping a surrogate for its acquired source is a data
 * change plus a corpus version bump, never a generator rewrite.
 *
 * Nothing here is drawn from a real person, a real address, or a licensed
 * vocabulary. Every string is invented for this corpus.
 */

export type SourceAcquisitionState = 'surrogate-pending-acquisition' | 'acquired-pinned';

export interface CorpusSourceRegisterRow {
  readonly sourceId: string;
  /** The real dataset this row is about. */
  readonly realSource: string;
  readonly publisher: string;
  readonly licenseClass: string;
  readonly state: SourceAcquisitionState;
  /** What synthgen v1 uses in its place while the acquisition is outstanding. */
  readonly surrogate: string;
  /** The register entry that gates the acquisition. */
  readonly externalWaitRef: string;
}

export const sourceRegisterV1: readonly CorpusSourceRegisterRow[] = [
  {
    sourceId: 'given-name-frequency',
    realSource: 'SSA national + state baby names',
    publisher: 'US Social Security Administration',
    licenseClass: 'public-domain',
    state: 'surrogate-pending-acquisition',
    surrogate: 'invented given-name pool with a declared frequency weighting',
    externalWaitRef: 'src-acquisitions',
  },
  {
    sourceId: 'surname-frequency',
    realSource: 'US Census surname frequency file',
    publisher: 'US Census Bureau',
    licenseClass: 'public-domain',
    state: 'surrogate-pending-acquisition',
    surrogate: 'invented surname pool sized to force realistic collision rates',
    externalWaitRef: 'src-acquisitions',
  },
  {
    sourceId: 'address-geometry',
    realSource: 'Census TIGER/Line + gazetteer',
    publisher: 'US Census Bureau',
    licenseClass: 'public-domain',
    state: 'surrogate-pending-acquisition',
    surrogate: 'invented street/city pools per practice state',
    externalWaitRef: 'src-acquisitions',
  },
  {
    sourceId: 'clinical-backbone',
    realSource:
      'Synthea synthetic patient generator (pinned release + practice-authored GMF modules)',
    publisher: 'MITRE / synthetichealth',
    licenseClass: 'apache-2.0 (code); generated output unrestricted',
    state: 'surrogate-pending-acquisition',
    surrogate:
      'sims/synthea-runner — a deterministic in-repo stub emitting the same export row shapes',
    externalWaitRef: 'src-acquisitions',
  },
  {
    sourceId: 'claims-distributions',
    realSource: 'CMS DE-SynPUF + Synthetic RIF',
    publisher: 'CMS',
    licenseClass: 'public-synthetic',
    state: 'surrogate-pending-acquisition',
    surrogate: 'not modelled at v1 — the RCM lifecycle corpus lands with its own packages',
    externalWaitRef: 'src-acquisitions',
  },
];

/**
 * Invented given names. The pool is deliberately SMALL relative to the subject
 * count so that name collisions arise naturally — the acquired-clinic duplicate
 * problem is the corpus's whole point, and a pool wide enough to avoid
 * collisions would generate an unrealistically easy world.
 */
export const givenNamePool: readonly string[] = [
  'Alder',
  'Bryn',
  'Cassian',
  'Delphine',
  'Emory',
  'Fenwick',
  'Greer',
  'Halden',
  'Isolde',
  'Jorun',
  'Kestrel',
  'Lorimer',
  'Maren',
  'Nerys',
  'Orsen',
  'Pell',
  'Quillon',
  'Rowe',
  'Sable',
  'Thorne',
  'Ulric',
  'Verity',
  'Wren',
  'Xandra',
  'Yarrow',
  'Zeph',
];

/** Invented surnames; same sizing logic as the given-name pool. */
export const familyNamePool: readonly string[] = [
  'Abernathy',
  'Broadmoor',
  'Castellan',
  'Dunmore',
  'Ellsworth',
  'Farraday',
  'Greenhalgh',
  'Hollowell',
  'Ironside',
  'Jessamy',
  'Kirkbride',
  'Lindqvist',
  'Marchetti',
  'Northcott',
  'Oakhurst',
  'Pemberton',
  'Quintrell',
  'Ravenswood',
  'Stillwater',
  'Thackeray',
  'Underhill',
  'Vandermeer',
  'Whitlock',
  'Yardley',
];

/** Affirmed names that differ from the legal name (WP-013 name-context slice). */
export const affirmedNamePool: readonly string[] = ['Ash', 'Bex', 'Cove', 'Dell', 'Ives', 'Sol'];

export interface StateGeography {
  readonly stateCode: string;
  readonly cities: readonly string[];
  readonly streets: readonly string[];
}

/**
 * Practice states (NV/FL/IL/MN) plus an out-of-jurisdiction state that exists
 * only so the corpus carries subjects whose residence does not match the
 * location that sees them — the multi-state telehealth case, and the input the
 * WP-011 jurisdiction resolver's divergence path needs.
 */
export const stateGeographyV1: readonly StateGeography[] = [
  {
    stateCode: 'NV',
    cities: ['Verdant Springs', 'Dry Fork', 'Ridgeline'],
    streets: ['Sandstone Way', 'Juniper Row', 'Basalt Terrace'],
  },
  {
    stateCode: 'FL',
    cities: ['Palmetto Reach', 'Coral Landing', 'Bayhead'],
    streets: ['Mangrove Lane', 'Tidewater Court', 'Seagrape Drive'],
  },
  {
    stateCode: 'IL',
    cities: ['Northgate', 'Prairie Junction', 'Millwater'],
    streets: ['Elmbank Street', 'Granary Road', 'Lakeshore Bend'],
  },
  {
    stateCode: 'MN',
    cities: ['Birchfield', 'Stonebrook', 'Larkhaven'],
    streets: ['Aspen Hollow', 'Ferry Landing', 'Northwoods Trail'],
  },
  {
    stateCode: 'OR',
    cities: ['Cedar Bluff', 'Fernhollow'],
    streets: ['Basin Street', 'Timberline Way'],
  },
];

/**
 * Legacy source systems a corpus subject can carry an identifier in. These name
 * the acquired-clinic crosswalk shape (WP-013 `source_identifier`), not any real
 * product.
 */
export const legacySourceSystems: readonly string[] = [
  'legacy-northgate-emr',
  'legacy-prairie-clinic',
  'legacy-bayhead-records',
];

/**
 * Deliberately license-free condition and medication descriptors. Real coded
 * vocabularies (ICD-10, RxNorm, LOINC, CPT) are acquisition-gated and licensed;
 * synthgen v1 emits internally-namespaced codes so no licensed content enters
 * the repo (synthetic-data-plan §1 "licensed content never embedded").
 */
export const conditionCatalog: readonly { readonly code: string; readonly description: string }[] =
  [
    { code: 'SYN-COND-001', description: 'Synthetic metabolic risk cohort marker' },
    { code: 'SYN-COND-002', description: 'Synthetic hypertension storyline' },
    { code: 'SYN-COND-003', description: 'Synthetic chronic-care follow-up storyline' },
    { code: 'SYN-COND-004', description: 'Synthetic longevity-panel finding' },
    { code: 'SYN-COND-005', description: 'Synthetic corrected-result storyline' },
  ];

export const medicationCatalog: readonly {
  readonly code: string;
  readonly description: string;
}[] = [
  { code: 'SYN-MED-001', description: 'Synthetic weight-management therapy' },
  { code: 'SYN-MED-002', description: 'Synthetic antihypertensive' },
  { code: 'SYN-MED-003', description: 'Synthetic supplement protocol' },
  { code: 'SYN-MED-004', description: 'Synthetic controlled-substance storyline agent' },
];

export const encounterClasses: readonly string[] = ['ambulatory', 'virtual', 'wellness'];
