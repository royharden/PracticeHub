/**
 * Jurisdiction rule packs v1 (WP-011) — the versioned, effective-dated data
 * of record for the strictest-law cascade. Content encodes
 * docs/compliance/state-matrix.md (NV/FL/IL/MN + the sec 0 governing rules);
 * every rule cites its matrix row or R6-SR id. Packs are counsel-owned data
 * under EW-025: all v1 packs are `draft` (counsel sign-off is an external
 * wait — the resolver surfaces `counselReviewPending` until a signed version
 * supersedes these), and every change routes through a change-control ref
 * plus the truth-table regression harness (jurisdiction.test.ts).
 *
 * Effective dating (ADR-ADJ-002 remediation item 2): the four state packs'
 * v1 carry the pinned synthetic baseline date so current resolution behavior
 * is unchanged for as-of-now consumers; the floor and unknown packs carry
 * the epoch sentinel — the fail-closed substrate is effective at every
 * queriable as-of.
 *
 * The committed seed `infra/postgres/seed/004-jurisdiction-seed.sql` embeds
 * the output of `renderJurisdictionSeedSection(jurisdictionPacksV1)` between
 * `-- jurisdiction:generated:begin/end` markers; a drift test compares them.
 */

import type { JurisdictionRulePack } from './jurisdiction.js';
import { epochEffectiveOn } from './effective-dating.js';

const sm = (row: string): string => `state-matrix ${row}`;

/**
 * Pinned synthetic baseline effective date for the v1 state packs
 * (ADR-ADJ-002 remediation item 2): a fixed calendar date at or before any
 * as-of the build evaluates, so the effective-dated selection resolves the
 * same versions the version-only selection did — current behavior is
 * byte-identical (the truth-table zero-cell diff is the proof).
 */
export const packBaselineEffectiveOn = '2026-01-01';

export const jurisdictionPacksV1: readonly JurisdictionRulePack[] = [
  {
    jurisdiction: 'NV',
    version: 1,
    effectiveOn: packBaselineEffectiveOn,
    status: 'draft',
    changeControlRef: 'synthetic-ccr-jur-nv-001',
    synthetic: true,
    rules: [
      {
        topic: 'recording-consent',
        obligations: ['all-party-consent'],
        sourceRef: sm('sec 1 NRS 200.620'),
      },
      {
        topic: 'chd-rights',
        obligations: [
          'chd-opt-in',
          'chd-sale-separate-authorization',
          'chd-geofence-ban',
          'chd-privacy-policy',
        ],
        sourceRef: sm('sec 2 NV SB 370'),
      },
      {
        topic: 'genetic-authorization',
        obligations: ['genetic-informed-consent'],
        sourceRef: sm('sec 3 GINA + NV genetic-privacy'),
      },
      {
        topic: 'records-consent',
        obligations: ['hipaa-authorization'],
        sourceRef: sm('sec 4 NRS 629'),
      },
      {
        topic: 'erx-epcs-pdmp',
        obligations: ['erx-mandate', 'epcs-two-factor', 'pdmp-check', 'prescriber-state-rules'],
        sourceRef: sm('sec 5 NV Board of Pharmacy + federal EPCS'),
      },
      {
        topic: 'telehealth-licensure',
        obligations: ['patient-presence-state-licensure', 'hard-block-unlicensed'],
        sourceRef: sm('sec 6 NV licensure'),
      },
      {
        topic: 'auto-renewal',
        obligations: ['affirmative-consent-disclosure', 'one-step-cancellation'],
        sourceRef: sm('sec 7 NRS 598.2807'),
      },
      {
        topic: 'retention',
        obligations: [
          'per-state-retention-clock',
          'minor-extended-retention',
          'legal-hold-override',
        ],
        scalars: { 'retention-years-adult': 5 },
        sourceRef: sm('sec 8 NRS 629.051'),
      },
      {
        topic: 'biometrics',
        obligations: ['biometric-consent'],
        sourceRef: sm('sec 9 NV privacy provisions'),
      },
      {
        topic: 'ai-disclosure',
        obligations: ['ai-disclosure', 'no-ai-therapy-representation'],
        sourceRef: sm('sec 10 NV AB 406'),
      },
      {
        topic: 'cpom',
        obligations: ['pc-mso-split', 'counsel-structure-review'],
        sourceRef: sm('sec 11 NV CPOM'),
      },
      {
        topic: 'minors-part2',
        obligations: [],
        sourceRef: sm('sec 12 R6-SR-121 per-state config'),
      },
    ],
  },
  {
    jurisdiction: 'FL',
    version: 1,
    effectiveOn: packBaselineEffectiveOn,
    status: 'draft',
    changeControlRef: 'synthetic-ccr-jur-fl-001',
    synthetic: true,
    rules: [
      {
        topic: 'recording-consent',
        obligations: ['all-party-consent'],
        sourceRef: sm('sec 1 Fla. Stat. sec 934.03'),
      },
      {
        topic: 'chd-rights',
        obligations: [],
        sourceRef: sm('sec 2 FL: no CHD statute; FDUTPA baseline'),
      },
      {
        topic: 'genetic-authorization',
        obligations: ['genetic-informed-consent'],
        sourceRef: sm('sec 3 Fla. Stat. sec 760.40'),
      },
      {
        topic: 'records-consent',
        obligations: ['written-consent'],
        sourceRef: sm('sec 4 Fla. Stat. sec 456.057'),
      },
      {
        topic: 'erx-epcs-pdmp',
        obligations: ['erx-mandate', 'epcs-two-factor', 'pdmp-check', 'prescriber-state-rules'],
        sourceRef: sm('sec 5 Fla. Stat. sec 456.42'),
      },
      {
        topic: 'telehealth-licensure',
        obligations: ['patient-presence-state-licensure', 'hard-block-unlicensed'],
        sourceRef: sm('sec 6 FL license or telehealth registration'),
      },
      {
        topic: 'auto-renewal',
        obligations: ['affirmative-consent-disclosure', 'one-step-cancellation'],
        sourceRef: sm('sec 7 Fla. Stat. sec 501.0605'),
      },
      {
        topic: 'retention',
        obligations: [
          'per-state-retention-clock',
          'minor-extended-retention',
          'legal-hold-override',
        ],
        scalars: { 'retention-years-adult': 5 },
        sourceRef: sm('sec 8 FL Admin Code 64B8-10.002'),
      },
      {
        topic: 'biometrics',
        obligations: ['biometric-consent'],
        sourceRef: sm('sec 9 FL: no BIPA equivalent'),
      },
      {
        topic: 'ai-disclosure',
        obligations: ['ai-disclosure'],
        sourceRef: sm('sec 10 FDUTPA truthful-AI'),
      },
      {
        topic: 'cpom',
        obligations: ['counsel-structure-review'],
        sourceRef: sm('sec 11 FL permissive + MSO'),
      },
      {
        topic: 'minors-part2',
        obligations: [],
        sourceRef: sm('sec 12 R6-SR-121 per-state config'),
      },
    ],
  },
  {
    jurisdiction: 'IL',
    version: 1,
    effectiveOn: packBaselineEffectiveOn,
    status: 'draft',
    changeControlRef: 'synthetic-ccr-jur-il-001',
    synthetic: true,
    rules: [
      {
        topic: 'recording-consent',
        obligations: ['all-party-consent'],
        sourceRef: sm('sec 1 720 ILCS 5/14'),
      },
      {
        topic: 'chd-rights',
        obligations: [],
        sourceRef: sm('sec 2 IL: no standalone CHD statute'),
      },
      {
        topic: 'genetic-authorization',
        obligations: ['gipa-written-authorization', 'genetic-partition', 'employer-carve-out'],
        sourceRef: sm('sec 3 GIPA 410 ILCS 513'),
      },
      {
        topic: 'records-consent',
        obligations: ['hipaa-authorization', 'mh-heightened-consent'],
        sourceRef: sm('sec 4 740 ILCS 110'),
      },
      {
        topic: 'erx-epcs-pdmp',
        obligations: ['erx-mandate', 'epcs-two-factor', 'pdmp-check', 'prescriber-state-rules'],
        sourceRef: sm('sec 5 IL EPCS mandate'),
      },
      {
        topic: 'telehealth-licensure',
        obligations: ['patient-presence-state-licensure', 'hard-block-unlicensed'],
        sourceRef: sm('sec 6 IL licensure'),
      },
      {
        topic: 'auto-renewal',
        obligations: ['renewal-reminder', 'affirmative-consent-disclosure'],
        sourceRef: sm('sec 7 815 ILCS 601'),
      },
      {
        topic: 'retention',
        obligations: [
          'per-state-retention-clock',
          'minor-extended-retention',
          'legal-hold-override',
        ],
        scalars: { 'retention-years-adult': 10 },
        sourceRef: sm('sec 8 IL adult records ~10yr'),
      },
      {
        topic: 'biometrics',
        obligations: ['bipa-written-release', 'retention-destruction-schedule'],
        sourceRef: sm('sec 9 BIPA 740 ILCS 14'),
      },
      {
        topic: 'ai-disclosure',
        obligations: ['ai-disclosure', 'no-ai-therapy-representation', 'human-oversight'],
        sourceRef: sm('sec 10 IL WOPR HB 1806'),
      },
      {
        topic: 'cpom',
        obligations: ['pc-mso-split', 'counsel-structure-review'],
        sourceRef: sm('sec 11 IL CPOM'),
      },
      {
        topic: 'minors-part2',
        obligations: [],
        sourceRef: sm('sec 12 R6-SR-121 per-state config'),
      },
    ],
  },
  {
    jurisdiction: 'MN',
    version: 1,
    effectiveOn: packBaselineEffectiveOn,
    status: 'draft',
    changeControlRef: 'synthetic-ccr-jur-mn-001',
    synthetic: true,
    rules: [
      {
        topic: 'recording-consent',
        obligations: ['one-party-consent'],
        sourceRef: sm('sec 1 Minn. Stat. sec 626A.02 (floor lifts to all-party)'),
      },
      {
        topic: 'chd-rights',
        obligations: ['chd-opt-in'],
        sourceRef: sm('sec 2 MCDPA sensitive data'),
      },
      {
        topic: 'genetic-authorization',
        obligations: ['genetic-informed-consent'],
        sourceRef: sm('sec 3 MHRA + MN genetic provisions'),
      },
      {
        topic: 'records-consent',
        obligations: ['written-consent', 'consent-expiry'],
        scalars: { 'consent-expiry-days': 365 },
        sourceRef: sm('sec 4 MHRA secs 144.291-.298 + sec 144.2925'),
      },
      {
        topic: 'erx-epcs-pdmp',
        obligations: ['erx-mandate', 'epcs-two-factor', 'pdmp-check', 'prescriber-state-rules'],
        sourceRef: sm('sec 5 Minn. Stat. sec 62J.497'),
      },
      {
        topic: 'telehealth-licensure',
        obligations: ['patient-presence-state-licensure', 'hard-block-unlicensed'],
        sourceRef: sm('sec 6 MN license or compact'),
      },
      {
        topic: 'auto-renewal',
        obligations: [
          'renewal-reminder',
          'affirmative-consent-disclosure',
          'one-step-cancellation',
        ],
        sourceRef: sm('sec 7 MN auto-renewal (beyond ROSCA)'),
      },
      {
        topic: 'retention',
        obligations: [
          'per-state-retention-clock',
          'minor-extended-retention',
          'legal-hold-override',
        ],
        scalars: { 'retention-years-adult': 7 },
        sourceRef: sm('sec 8 MN ~7yr'),
      },
      {
        topic: 'biometrics',
        obligations: ['biometric-consent'],
        sourceRef: sm('sec 9 MCDPA biometric'),
      },
      {
        topic: 'ai-disclosure',
        obligations: ['ai-disclosure'],
        sourceRef: sm('sec 10 MCDPA + consumer protection'),
      },
      {
        topic: 'cpom',
        obligations: ['counsel-structure-review'],
        sourceRef: sm('sec 11 MN CPOM nuances'),
      },
      {
        topic: 'minors-part2',
        obligations: [],
        sourceRef: sm('sec 12 R6-SR-121 per-state config'),
      },
    ],
  },
  {
    // Platform floor: unioned into EVERY resolution — the "no relaxation"
    // postures the matrix mandates regardless of state (R6-SR-002 defaults,
    // sec 0.2 safe default, Virtual rows).
    jurisdiction: 'floor',
    version: 1,
    effectiveOn: epochEffectiveOn,
    status: 'draft',
    changeControlRef: 'synthetic-ccr-jur-floor-001',
    synthetic: true,
    rules: [
      {
        topic: 'recording-consent',
        obligations: ['all-party-consent'],
        sourceRef: sm('sec 1 all-party default everywhere'),
      },
      {
        topic: 'chd-rights',
        obligations: [
          'chd-opt-in',
          'chd-sale-separate-authorization',
          'chd-geofence-ban',
          'chd-privacy-policy',
        ],
        sourceRef: sm('sec 2 Virtual: SB 370 as national floor (R6-SR-020..022)'),
      },
      {
        topic: 'genetic-authorization',
        obligations: ['gipa-written-authorization', 'genetic-partition', 'employer-carve-out'],
        sourceRef: sm('sec 3 Virtual: GIPA-grade regardless of patient state (R6-SR-030..032)'),
      },
      { topic: 'records-consent', obligations: [], sourceRef: sm('sec 4 cascade per state') },
      {
        topic: 'erx-epcs-pdmp',
        obligations: ['epcs-two-factor', 'prescriber-state-rules'],
        sourceRef: sm('sec 5 Virtual: federal EPCS everywhere'),
      },
      {
        topic: 'telehealth-licensure',
        obligations: ['patient-presence-state-licensure', 'hard-block-unlicensed'],
        sourceRef: sm('sec 6 Virtual: patient-presence state governs (R6-SR-060)'),
      },
      {
        topic: 'auto-renewal',
        obligations: [
          'strictest-state-standard',
          'renewal-reminder',
          'affirmative-consent-disclosure',
          'one-step-cancellation',
        ],
        sourceRef: sm('sec 7 R6-SR-070 strictest-state standard'),
      },
      {
        topic: 'retention',
        obligations: [
          'per-state-retention-clock',
          'minor-extended-retention',
          'legal-hold-override',
        ],
        sourceRef: sm('sec 8 R6-SR-080 longest applicable'),
      },
      {
        topic: 'biometrics',
        obligations: ['no-biometric-enrollment-default'],
        sourceRef: sm('sec 9 R6-SR-090 no-voiceprint default'),
      },
      {
        topic: 'ai-disclosure',
        obligations: [
          'ai-disclosure',
          'no-ai-therapy-representation',
          'crisis-protocol',
          'human-oversight',
        ],
        sourceRef: sm('sec 10 R6-SR-100 strictest common denominator'),
      },
      {
        topic: 'cpom',
        obligations: ['counsel-structure-review'],
        sourceRef: sm('sec 11 R6-SR-110 counsel'),
      },
      {
        topic: 'minors-part2',
        obligations: ['strictest-minor-confidentiality', 'part2-segmentation-ready'],
        sourceRef: sm('sec 12 R6-SR-120/121'),
      },
    ],
  },
  {
    // Safe defaults: contributed whenever a location fact is unknown OR a
    // known state has no pack (NFR-14 fifth-state path). Strictest posture per
    // topic — a mis-detected location fails safe (ADR-005: all-party / opt-in
    // / written-consent / hard-block).
    jurisdiction: 'unknown',
    version: 1,
    effectiveOn: epochEffectiveOn,
    status: 'draft',
    changeControlRef: 'synthetic-ccr-jur-unknown-001',
    synthetic: true,
    rules: [
      {
        topic: 'recording-consent',
        obligations: ['all-party-consent'],
        sourceRef: sm('sec 0.2 safe default: all-party'),
      },
      {
        topic: 'chd-rights',
        obligations: [
          'chd-opt-in',
          'chd-sale-separate-authorization',
          'chd-geofence-ban',
          'chd-privacy-policy',
        ],
        sourceRef: sm('sec 0.2 safe default: opt-in'),
      },
      {
        topic: 'genetic-authorization',
        obligations: ['gipa-written-authorization', 'genetic-partition', 'employer-carve-out'],
        sourceRef: sm('sec 3 strictest = GIPA'),
      },
      {
        topic: 'records-consent',
        obligations: ['written-consent', 'consent-expiry'],
        scalars: { 'consent-expiry-days': 365 },
        sourceRef: sm('sec 4 strictest = MHRA'),
      },
      {
        topic: 'erx-epcs-pdmp',
        obligations: [
          'erx-mandate',
          'epcs-two-factor',
          'pdmp-check',
          'jurisdiction-unverified-hard-block',
        ],
        sourceRef: sm('sec 5 unknown prescribing jurisdiction blocks'),
      },
      {
        topic: 'telehealth-licensure',
        obligations: [
          'patient-presence-state-licensure',
          'hard-block-unlicensed',
          'jurisdiction-unverified-hard-block',
        ],
        sourceRef: sm('sec 6 unverifiable licensure blocks (R6-SR-003)'),
      },
      {
        topic: 'auto-renewal',
        obligations: [
          'strictest-state-standard',
          'renewal-reminder',
          'affirmative-consent-disclosure',
          'one-step-cancellation',
        ],
        sourceRef: sm('sec 7 strictest state'),
      },
      {
        topic: 'retention',
        obligations: [
          'per-state-retention-clock',
          'minor-extended-retention',
          'legal-hold-override',
        ],
        scalars: { 'retention-years-adult': 10 },
        sourceRef: sm('sec 8 longest applicable (IL 10yr)'),
      },
      {
        topic: 'biometrics',
        obligations: [
          'no-biometric-enrollment-default',
          'bipa-written-release',
          'retention-destruction-schedule',
        ],
        sourceRef: sm('sec 9 strictest = BIPA'),
      },
      {
        topic: 'ai-disclosure',
        obligations: [
          'ai-disclosure',
          'no-ai-therapy-representation',
          'crisis-protocol',
          'human-oversight',
        ],
        sourceRef: sm('sec 10 strictest common denominator'),
      },
      {
        topic: 'cpom',
        obligations: ['pc-mso-split', 'counsel-structure-review'],
        sourceRef: sm('sec 11 restrictive'),
      },
      {
        topic: 'minors-part2',
        obligations: ['strictest-minor-confidentiality', 'part2-segmentation-ready'],
        sourceRef: sm('sec 12 strictest applicable'),
      },
    ],
  },
];

export const jurisdictionSeedBeginMarker = '-- jurisdiction:generated:begin';
export const jurisdictionSeedEndMarker = '-- jurisdiction:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Render the pack registry as idempotent seed SQL. The committed seed file
 * embeds this section verbatim between the jurisdiction markers; the drift
 * test (jurisdiction.test.ts) fails on divergence, and the DB suite compares
 * the seeded rows back against this registry — one data source, two proofs.
 */
export function renderJurisdictionSeedSection(packs: readonly JurisdictionRulePack[]): string {
  const packRows = [...packs]
    .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.version - b.version)
    .map(
      (pack) =>
        `  (${sqlLiteral(pack.jurisdiction)}, ${pack.version}, ` +
        `DATE ${sqlLiteral(pack.effectiveOn)}, ${sqlLiteral(pack.status)}, ` +
        `${pack.counselSignoffRef ? sqlLiteral(pack.counselSignoffRef) : 'NULL'}, ` +
        `${sqlLiteral(pack.changeControlRef)}, true)`,
    );
  const ruleRows = [...packs]
    .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.version - b.version)
    .flatMap((pack) =>
      [...pack.rules]
        .sort((a, b) => a.topic.localeCompare(b.topic))
        .map(
          (rule) =>
            `  (${sqlLiteral(pack.jurisdiction)}, ${pack.version}, ${sqlLiteral(rule.topic)}, ` +
            `${sqlLiteral(JSON.stringify([...rule.obligations].sort()))}::jsonb, ` +
            `${sqlLiteral(JSON.stringify(rule.scalars ?? {}))}::jsonb, ` +
            `${sqlLiteral(rule.sourceRef)}, true)`,
        ),
    );
  return [
    jurisdictionSeedBeginMarker,
    '-- Generated by @practicehub/platform-core renderJurisdictionSeedSection',
    '-- from jurisdictionPacksV1. Regenerate on any pack change; the drift test',
    '-- and the DB registry-sync test fail on divergence.',
    'INSERT INTO platform_core.jurisdiction_rule_pack',
    '  (jurisdiction, version, effective_on, status, counsel_signoff_ref, change_control_ref, synthetic)',
    'VALUES',
    packRows.join(',\n'),
    'ON CONFLICT (jurisdiction, version) DO UPDATE',
    'SET effective_on = EXCLUDED.effective_on,',
    '    status = EXCLUDED.status,',
    '    counsel_signoff_ref = EXCLUDED.counsel_signoff_ref,',
    '    change_control_ref = EXCLUDED.change_control_ref,',
    '    synthetic = EXCLUDED.synthetic;',
    '',
    'INSERT INTO platform_core.jurisdiction_rule',
    '  (jurisdiction, pack_version, topic, obligations, scalars, source_ref, synthetic)',
    'VALUES',
    ruleRows.join(',\n'),
    'ON CONFLICT (jurisdiction, pack_version, topic) DO UPDATE',
    'SET obligations = EXCLUDED.obligations,',
    '    scalars = EXCLUDED.scalars,',
    '    source_ref = EXCLUDED.source_ref,',
    '    synthetic = EXCLUDED.synthetic;',
    jurisdictionSeedEndMarker,
  ].join('\n');
}
