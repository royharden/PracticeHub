import { RcmShadowError } from './contracts.js';

export type RuleFamily = 'NCCI' | 'MUE' | 'LCD-NCD';

export interface RuleEdit {
  readonly editId: string;
  readonly code: string;
  readonly maxUnits: number | null;
}

export interface RulePack {
  readonly packId: string;
  readonly family: RuleFamily;
  readonly version: string;
  readonly effectiveOn: string;
  readonly edits: readonly RuleEdit[];
}

export interface ClaimLine {
  readonly lineId: string;
  readonly code: string;
  readonly units: number;
  readonly serviceDate: string;
}

export interface ProducedEdit {
  readonly editId: string;
  readonly lineId: string;
  readonly family: RuleFamily;
  readonly code: string;
  readonly version: string;
  readonly packId: string;
}

export interface RuleRegression {
  readonly passed: boolean;
  readonly dropped: readonly ProducedEdit[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function assertPack(pack: RulePack): void {
  if (pack.family !== 'NCCI' && pack.family !== 'MUE' && pack.family !== 'LCD-NCD') {
    throw new RcmShadowError('RULE_PACK', 'family must be NCCI, MUE, or LCD-NCD');
  }
  if (pack.version.length === 0 || pack.packId.length === 0 || !DAY.test(pack.effectiveOn)) {
    throw new RcmShadowError('RULE_PACK', 'pack version, id, and effectiveOn are required');
  }
}

function fires(edit: RuleEdit, line: ClaimLine, family: RuleFamily): boolean {
  if (edit.code !== line.code) {
    return false;
  }
  if (family === 'MUE') {
    return edit.maxUnits !== null && line.units > edit.maxUnits;
  }
  return true;
}

export function applyRulePack(
  pack: RulePack,
  lines: readonly ClaimLine[],
): readonly ProducedEdit[] {
  assertPack(pack);
  const produced: ProducedEdit[] = [];
  for (const line of lines) {
    if (!DAY.test(line.serviceDate) || !Number.isSafeInteger(line.units) || line.units < 0) {
      throw new RcmShadowError('CLAIM_LINE', 'serviceDate and units must be valid');
    }
    if (line.serviceDate < pack.effectiveOn) {
      continue;
    }
    for (const edit of pack.edits) {
      if (!fires(edit, line, pack.family)) {
        continue;
      }
      produced.push({
        editId: edit.editId,
        lineId: line.lineId,
        family: pack.family,
        code: line.code,
        version: pack.version,
        packId: pack.packId,
      });
    }
  }
  return produced;
}

function keyOf(edit: ProducedEdit): string {
  return `${edit.family}\u001f${edit.editId}\u001f${edit.lineId}\u001f${edit.code}`;
}

export function regressRulePack(
  baseline: readonly ProducedEdit[],
  candidate: readonly ProducedEdit[],
): RuleRegression {
  const candidateKeys = new Set(candidate.map(keyOf));
  const dropped = baseline.filter((edit) => !candidateKeys.has(keyOf(edit)));
  return { passed: dropped.length === 0, dropped };
}
