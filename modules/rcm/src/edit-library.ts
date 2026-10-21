import { RcmShadowError } from './contracts.js';

export type RuleFamily = 'NCCI' | 'MUE' | 'LCD-NCD';

/**
 * NCCI procedure-to-procedure modifier indicator: `0` never bypassable, `1` bypassable with an
 * NCCI-associated modifier on the column-2 line, `9` edit not applicable (never fires).
 */
export type NcciModifierIndicator = '0' | '1' | '9';

/** Modifiers that bypass an indicator-1 NCCI pair edit when present on the column-2 line. */
export const NCCI_BYPASS_MODIFIERS: readonly string[] = ['59', 'XE', 'XS', 'XP', 'XU'];

export interface RuleEdit {
  readonly editId: string;
  /** Column-1 code for an NCCI pair edit; the code the edit targets otherwise. */
  readonly code: string;
  readonly maxUnits: number | null;
  /**
   * NCCI only. When set, the edit is a procedure-to-procedure pair: it fires on a line coded
   * `column2Code` when another line on the same date of service is coded `code`. When absent, an
   * NCCI entry stays a code-level edit that fires on every line with `code`. That legacy form is
   * kept only because the WP-086 claims fixture relies on it (NR-123); new packs use pairs.
   */
  readonly column2Code?: string;
  /** NCCI pair edits only; defaults to `0`. */
  readonly modifierIndicator?: NcciModifierIndicator;
}

export interface RulePack {
  readonly packId: string;
  readonly family: RuleFamily;
  readonly version: string;
  readonly effectiveOn: string;
  /**
   * Last service date the pack applies to, inclusive. When absent, `selectRulePack` ends the pack
   * the day before the next version of the same family takes effect (supersession).
   */
  readonly effectiveThrough?: string;
  readonly edits: readonly RuleEdit[];
}

export interface ClaimLine {
  readonly lineId: string;
  readonly code: string;
  readonly units: number;
  readonly serviceDate: string;
  readonly modifiers?: readonly string[];
}

export interface ProducedEdit {
  readonly editId: string;
  readonly lineId: string;
  readonly family: RuleFamily;
  readonly code: string;
  readonly version: string;
  readonly packId: string;
  /** NCCI pair edits: the column-1 line that caused the column-2 line to be edited. */
  readonly pairedLineId?: string;
  /** MUE edits: every line of the code on the date of service, and their summed units. */
  readonly lineIds?: readonly string[];
  readonly unitsTotal?: number;
}

export interface RuleRegression {
  readonly passed: boolean;
  readonly dropped: readonly ProducedEdit[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INDICATORS: readonly string[] = ['0', '1', '9'];

function assertPack(pack: RulePack): void {
  if (pack.family !== 'NCCI' && pack.family !== 'MUE' && pack.family !== 'LCD-NCD') {
    throw new RcmShadowError('RULE_PACK', 'family must be NCCI, MUE, or LCD-NCD');
  }
  if (pack.version.length === 0 || pack.packId.length === 0 || !DAY.test(pack.effectiveOn)) {
    throw new RcmShadowError('RULE_PACK', 'pack version, id, and effectiveOn are required');
  }
  if (
    pack.effectiveThrough !== undefined &&
    (!DAY.test(pack.effectiveThrough) || pack.effectiveThrough < pack.effectiveOn)
  ) {
    throw new RcmShadowError('RULE_PACK', 'effectiveThrough must be a day on or after effectiveOn');
  }
  for (const edit of pack.edits) {
    if (edit.column2Code === undefined) {
      if (edit.modifierIndicator !== undefined) {
        throw new RcmShadowError('RULE_PACK', 'a modifier indicator needs an NCCI pair edit');
      }
      continue;
    }
    if (pack.family !== 'NCCI') {
      throw new RcmShadowError('RULE_PACK', 'only NCCI edits may name a column-2 code');
    }
    if (edit.column2Code === edit.code || edit.column2Code.length === 0) {
      throw new RcmShadowError('RULE_PACK', 'an NCCI pair needs two different codes');
    }
    if (edit.modifierIndicator !== undefined && !INDICATORS.includes(edit.modifierIndicator)) {
      throw new RcmShadowError('RULE_PACK', 'modifierIndicator must be 0, 1, or 9');
    }
  }
}

function assertLines(lines: readonly ClaimLine[]): void {
  for (const line of lines) {
    if (!DAY.test(line.serviceDate) || !Number.isSafeInteger(line.units) || line.units < 0) {
      throw new RcmShadowError('CLAIM_LINE', 'serviceDate and units must be valid');
    }
  }
}

function inForce(pack: RulePack, day: string): boolean {
  return (
    day >= pack.effectiveOn && (pack.effectiveThrough === undefined || day <= pack.effectiveThrough)
  );
}

function produced(pack: RulePack, edit: RuleEdit, line: ClaimLine): ProducedEdit {
  return {
    editId: edit.editId,
    lineId: line.lineId,
    family: pack.family,
    code: line.code,
    version: pack.version,
    packId: pack.packId,
  };
}

function ncciPairPartner(
  edit: RuleEdit,
  line: ClaimLine,
  lines: readonly ClaimLine[],
): ClaimLine | null {
  if (line.code !== edit.column2Code) return null;
  const indicator = edit.modifierIndicator ?? '0';
  if (indicator === '9') return null;
  if (indicator === '1' && (line.modifiers ?? []).some((m) => NCCI_BYPASS_MODIFIERS.includes(m))) {
    return null;
  }
  return (
    lines.find(
      (other) =>
        other !== line && other.code === edit.code && other.serviceDate === line.serviceDate,
    ) ?? null
  );
}

/** Service-date context that lets `applyRulePack` refuse a pack that is not the one in force. */
export interface RulePackContext {
  readonly serviceDate: string;
  /** Other versions of the pack's family; a newer one in force on `serviceDate` supersedes `pack`. */
  readonly versions?: readonly RulePack[];
}

/**
 * Applies one pack to the lines it is in force for. NCCI pair edits fire on the column-2 line;
 * MUE edits sum units per code per date of service across lines; other edits fire per line.
 *
 * @deprecated Applies `pack` without regard to supersession: a superseded version keeps firing
 * forever. Use `applyRulePacks`, which selects the version in force per line. When `context` is
 * given, a pack that is not in force on `context.serviceDate`, or that `context.versions`
 * supersede on that date, is refused with RULE_PACK_SUPERSEDED (NR-122).
 */
export function applyRulePack(
  pack: RulePack,
  lines: readonly ClaimLine[],
  context?: RulePackContext,
): readonly ProducedEdit[] {
  if (context !== undefined) {
    const selected = selectRulePack(
      [pack, ...(context.versions ?? []).filter((v) => v.packId !== pack.packId)],
      pack.family,
      context.serviceDate,
    );
    if (selected !== pack) {
      throw new RcmShadowError(
        'RULE_PACK_SUPERSEDED',
        `${pack.packId} is not the ${pack.family} version in force on ${context.serviceDate}`,
      );
    }
  }
  return applyPack(pack, lines);
}

function applyPack(pack: RulePack, lines: readonly ClaimLine[]): readonly ProducedEdit[] {
  assertPack(pack);
  assertLines(lines);
  const active = lines.filter((line) => inForce(pack, line.serviceDate));
  const out: ProducedEdit[] = [];

  if (pack.family === 'MUE') {
    const groups = new Map<string, ClaimLine[]>();
    for (const line of active) {
      const key = `${line.code}\u001f${line.serviceDate}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [line]);
      else group.push(line);
    }
    for (const group of groups.values()) {
      const [first] = group;
      if (first === undefined) continue;
      const unitsTotal = group.reduce((sum, line) => sum + line.units, 0);
      for (const edit of pack.edits) {
        if (edit.code !== first.code || edit.maxUnits === null || unitsTotal <= edit.maxUnits)
          continue;
        out.push({
          ...produced(pack, edit, first),
          lineIds: group.map((line) => line.lineId),
          unitsTotal,
        });
      }
    }
    return out;
  }

  for (const line of active) {
    for (const edit of pack.edits) {
      if (pack.family === 'NCCI' && edit.column2Code !== undefined) {
        const partner = ncciPairPartner(edit, line, active);
        if (partner !== null)
          out.push({ ...produced(pack, edit, line), pairedLineId: partner.lineId });
        continue;
      }
      if (edit.code === line.code) out.push(produced(pack, edit, line));
    }
  }
  return out;
}

/**
 * The pack of `family` in force on `serviceDate`: the latest `effectiveOn` on or before the date
 * whose `effectiveThrough` (if any) has not passed. A newer version supersedes an older one from
 * its own `effectiveOn`. Returns null when no version is in force.
 */
export function selectRulePack(
  packs: readonly RulePack[],
  family: RuleFamily,
  serviceDate: string,
): RulePack | null {
  if (!DAY.test(serviceDate))
    throw new RcmShadowError('CLAIM_LINE', 'serviceDate must be YYYY-MM-DD');
  const versions = packs.filter((pack) => pack.family === family);
  const starts = new Set<string>();
  for (const pack of versions) {
    assertPack(pack);
    if (starts.has(pack.effectiveOn)) {
      throw new RcmShadowError(
        'RULE_PACK',
        `two ${family} versions take effect on ${pack.effectiveOn}`,
      );
    }
    starts.add(pack.effectiveOn);
  }
  const latest = versions
    .filter((pack) => pack.effectiveOn <= serviceDate)
    .sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn))[0];
  if (latest === undefined) return null;
  return latest.effectiveThrough === undefined || serviceDate <= latest.effectiveThrough
    ? latest
    : null;
}

/** Applies, per family, only the version in force on each line's date of service. */
export function applyRulePacks(
  packs: readonly RulePack[],
  lines: readonly ClaimLine[],
): readonly ProducedEdit[] {
  assertLines(lines);
  const ids = new Set<string>();
  for (const pack of packs) {
    if (ids.has(pack.packId))
      throw new RcmShadowError('RULE_PACK', `duplicate packId ${pack.packId}`);
    ids.add(pack.packId);
  }
  const families = [...new Set(packs.map((pack) => pack.family))];
  const out: ProducedEdit[] = [];
  for (const family of families) {
    const byPack = new Map<RulePack, ClaimLine[]>();
    for (const line of lines) {
      const pack = selectRulePack(packs, family, line.serviceDate);
      if (pack === null) continue;
      const bucket = byPack.get(pack);
      if (bucket === undefined) byPack.set(pack, [line]);
      else bucket.push(line);
    }
    const ordered = [...byPack.entries()].sort(([a], [b]) =>
      a.effectiveOn.localeCompare(b.effectiveOn),
    );
    for (const [pack, packLines] of ordered) out.push(...applyPack(pack, packLines));
  }
  return out;
}

function keyOf(edit: ProducedEdit): string {
  return `${edit.family}\u001f${edit.editId}\u001f${edit.lineId}\u001f${edit.code}`;
}

/** Stable, human-readable edit identity used by stored regression baselines. */
export function editIdentity(edit: ProducedEdit): string {
  return `${edit.family}|${edit.editId}|${edit.lineId}|${edit.code}`;
}

export function regressRulePack(
  baseline: readonly ProducedEdit[],
  candidate: readonly ProducedEdit[],
): RuleRegression {
  const candidateKeys = new Set(candidate.map(keyOf));
  const dropped = baseline.filter((edit) => !candidateKeys.has(keyOf(edit)));
  return { passed: dropped.length === 0, dropped };
}

/** A committed corpus of date-neutral cases, every pack version, and each version's expected edits. */
export interface EditRegressionCorpus {
  readonly corpusId: string;
  readonly packs: readonly RulePack[];
  readonly cases: readonly {
    readonly caseId: string;
    readonly lines: readonly Omit<ClaimLine, 'serviceDate'>[];
  }[];
  /** Expected `editIdentity` values per pack per case. Every pack x case pair must be listed. */
  readonly baselines: readonly {
    readonly packId: string;
    readonly caseId: string;
    readonly edits: readonly string[];
  }[];
  /** Edits a version change drops on purpose. Any other drop fails the corpus. */
  readonly retired: readonly {
    readonly fromPackId: string;
    readonly toPackId: string;
    readonly caseId: string;
    readonly edit: string;
    readonly reason: string;
  }[];
}

export interface CorpusFailure {
  readonly kind: 'baseline-missing' | 'baseline-mismatch' | 'dropped-edit';
  readonly packId: string;
  readonly caseId: string;
  readonly detail: string;
}

export interface CorpusRun {
  readonly passed: boolean;
  readonly versionChanges: number;
  readonly checks: number;
  readonly failures: readonly CorpusFailure[];
}

/**
 * Runs the corpus: every pack must reproduce its stored baseline on every case, and every version
 * change within a family (ordered by effectiveOn) may drop only edits listed in `retired`. Each case
 * is dated to the pack's own effectiveOn, so date windows do not hide an edit.
 */
export function runEditRegressionCorpus(corpus: EditRegressionCorpus): CorpusRun {
  const failures: CorpusFailure[] = [];
  let checks = 0;
  const run = (pack: RulePack, caseId: string): readonly ProducedEdit[] => {
    const found = corpus.cases.find((c) => c.caseId === caseId);
    const lines = (found?.lines ?? []).map((line) => ({ ...line, serviceDate: pack.effectiveOn }));
    return applyPack(pack, lines);
  };

  for (const pack of corpus.packs) {
    for (const { caseId } of corpus.cases) {
      checks += 1;
      const expected = corpus.baselines.find(
        (b) => b.packId === pack.packId && b.caseId === caseId,
      );
      if (expected === undefined) {
        failures.push({
          kind: 'baseline-missing',
          packId: pack.packId,
          caseId,
          detail: 'no stored baseline',
        });
        continue;
      }
      const actual = run(pack, caseId).map(editIdentity).sort();
      const want = [...expected.edits].sort();
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        failures.push({
          kind: 'baseline-mismatch',
          packId: pack.packId,
          caseId,
          detail: `expected [${want.join(', ')}] got [${actual.join(', ')}]`,
        });
      }
    }
  }

  let versionChanges = 0;
  const families = [...new Set(corpus.packs.map((pack) => pack.family))];
  for (const family of families) {
    const versions = corpus.packs
      .filter((pack) => pack.family === family)
      .sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn));
    for (let i = 1; i < versions.length; i += 1) {
      const from = versions[i - 1];
      const to = versions[i];
      if (from === undefined || to === undefined) continue;
      versionChanges += 1;
      for (const { caseId } of corpus.cases) {
        checks += 1;
        const regression = regressRulePack(run(from, caseId), run(to, caseId));
        for (const edit of regression.dropped) {
          const identity = editIdentity(edit);
          const allowed = corpus.retired.some(
            (r) =>
              r.fromPackId === from.packId &&
              r.toPackId === to.packId &&
              r.caseId === caseId &&
              r.edit === identity,
          );
          if (!allowed) {
            failures.push({
              kind: 'dropped-edit',
              packId: to.packId,
              caseId,
              detail: `${identity} fires under ${from.packId} but not ${to.packId}`,
            });
          }
        }
      }
    }
  }
  return { passed: failures.length === 0, versionChanges, checks, failures };
}
