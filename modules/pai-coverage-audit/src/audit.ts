import { EXPECTED_PAI_IDS, type CanonicalRequirement } from './load-canonical.js';

export const REPORT_IDENTITY = 'WP-106/PAI-COVERAGE';

export interface PaiMappingRow {
  readonly paiId: string;
  readonly requirementIds: readonly string[];
  readonly hasReqAi: boolean;
}

export interface PaiCoverageAudit {
  readonly identity: typeof REPORT_IDENTITY;
  readonly uniquePaiIds: readonly string[];
  readonly mappings: readonly PaiMappingRow[];
  readonly unmappedPaiIds: readonly string[];
  readonly unexpectedPaiIds: readonly string[];
  readonly flaggedWithoutPai: readonly string[];
  readonly paiWithoutReqAi: readonly string[];
  readonly allExpectedMapped: boolean;
}

export function auditPaiCoverage(requirements: readonly CanonicalRequirement[]): PaiCoverageAudit {
  const byPai = new Map<string, string[]>();
  const flaggedWithoutPai: string[] = [];
  for (const requirement of requirements) {
    const refs = requirement.pai_refs ?? [];
    if (requirement.provider_ai_flag === true && refs.length === 0) {
      flaggedWithoutPai.push(requirement.id);
    }
    for (const paiId of refs) {
      const existing = byPai.get(paiId) ?? [];
      existing.push(requirement.id);
      byPai.set(paiId, existing);
    }
  }
  const uniquePaiIds = [...byPai.keys()].sort();
  const mappings: PaiMappingRow[] = uniquePaiIds.map((paiId) => {
    const requirementIds = byPai.get(paiId) ?? [];
    return {
      paiId,
      requirementIds,
      hasReqAi: requirementIds.some((id) => id.startsWith('REQ-AI-')),
    };
  });
  const unmappedPaiIds = EXPECTED_PAI_IDS.filter((paiId) => !byPai.has(paiId));
  const unexpectedPaiIds = uniquePaiIds.filter((paiId) => !EXPECTED_PAI_IDS.includes(paiId));
  const paiWithoutReqAi = mappings.filter((row) => !row.hasReqAi).map((row) => row.paiId);
  return {
    identity: REPORT_IDENTITY,
    uniquePaiIds,
    mappings,
    unmappedPaiIds,
    unexpectedPaiIds,
    flaggedWithoutPai,
    paiWithoutReqAi,
    allExpectedMapped: unmappedPaiIds.length === 0,
  };
}

export function renderAuditMarkdown(audit: PaiCoverageAudit): string {
  const rows = audit.mappings
    .map(
      (row) =>
        `| ${row.paiId} | ${String(row.requirementIds.length)} | ${row.hasReqAi ? 'yes' : 'no'} | ${row.requirementIds.slice(0, 6).join(', ')}${row.requirementIds.length > 6 ? ', …' : ''} |`,
    )
    .join('\n');
  return [
    `# ${REPORT_IDENTITY}`,
    '',
    `allExpectedMapped: ${String(audit.allExpectedMapped)}`,
    `uniquePaiIds: ${String(audit.uniquePaiIds.length)}`,
    `unmappedPaiIds: ${audit.unmappedPaiIds.join(', ') || '(none)'}`,
    `unexpectedPaiIds: ${audit.unexpectedPaiIds.join(', ') || '(none)'}`,
    `paiWithoutReqAi: ${audit.paiWithoutReqAi.join(', ') || '(none)'}`,
    `flaggedWithoutPai: ${String(audit.flaggedWithoutPai.length)} (${audit.flaggedWithoutPai.join(', ') || 'none'})`,
    '',
    '| PAI | req count | has REQ-AI | sample reqs |',
    '|---|---|---|---|',
    rows,
    '',
  ].join('\n');
}
