import { RcmShadowError } from '../contracts.js';

import { deriveCobOrder } from './order.js';
import {
  assertRemitBalances,
  patientResponsibility,
  type Wp054MspDetermination,
  type Wp089PostedRemit,
} from './placeholders.js';
import { assertCobTransition, isCobTerminal, type CobState } from './state-machine.js';
import {
  CROSSOVER_WINDOW_DAYS,
  type CobClaimSubmission,
  type CobEvent,
  type CobFinding,
  type CobOrder,
  type Coverage,
  type EpisodeInput,
  type PriorPayerAdjudication,
  type SubmissionRequest,
} from './types.js';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class CobSubmissionRefused extends RcmShadowError {
  public constructor(readonly findings: readonly CobFinding[]) {
    super('COB_SUBMISSION_REFUSED', findings.map((f) => `${f.flag}: ${f.detail}`).join('; '));
    this.name = 'CobSubmissionRefused';
  }
}

export type RemitOutcome =
  | { readonly status: 'posted'; readonly state: CobState }
  | { readonly status: 'duplicate'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string };

export interface CobEpisode {
  readonly input: EpisodeInput;
  readonly order: CobOrder;
  readonly state: CobState;
  /** Index into `order.payers` of the payer currently being billed or awaited. */
  readonly position: number;
  /** Amount the current payer is asked to consider. */
  readonly balanceMinor: number;
  readonly priorPayers: readonly PriorPayerAdjudication[];
  readonly submissions: readonly CobClaimSubmission[];
  readonly awaitingCrossoverSince: string | null;
}

interface MutableEpisode {
  input: EpisodeInput;
  order: CobOrder;
  state: CobState;
  position: number;
  balanceMinor: number;
  priorPayers: PriorPayerAdjudication[];
  submissions: CobClaimSubmission[];
  awaitingCrossoverSince: string | null;
  crossoverPositions: Set<number>;
  adjudicatedPositions: Set<number>;
}

interface EpisodeRef {
  readonly tenantId: string;
  readonly episodeId: string;
}

function fail(code: string, message: string): never {
  throw new RcmShadowError(code, message);
}

function dayOf(instant: string): string {
  return instant.slice(0, 10);
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round(
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000,
  );
}

/** Every stored identity is scoped by tenant: the same id in two tenants names two things. */
function scoped(tenantId: string, id: string): string {
  return `${tenantId}\u001f${id}`;
}

/**
 * Runs coordination of benefits for episodes of service. Every claim passes `preSubmissionCheck`
 * inside `submit`; a claim with any finding is refused before it can reach a clearinghouse. Every
 * call names the tenant, and another tenant's id behaves exactly like an unknown id.
 */
export class CobEngine {
  private readonly episodes = new Map<string, MutableEpisode>();
  private readonly controlNumbers = new Set<string>();
  private readonly remitIds = new Set<string>();
  private readonly log: CobEvent[] = [];

  public open(input: EpisodeInput, msp: Wp054MspDetermination | null, at: string): CobEpisode {
    for (const [field, value] of [
      ['episodeId', input.episodeId],
      ['tenantId', input.tenantId],
      ['patientId', input.patientId],
      ['encounterId', input.encounterId],
    ] as const) {
      if (!TOKEN.test(value)) fail('COB_INPUT', `${field} must be a token`);
    }
    if (!DAY.test(input.serviceDate)) fail('COB_INPUT', 'serviceDate must be YYYY-MM-DD');
    if (!Number.isSafeInteger(input.billedMinor) || input.billedMinor <= 0) {
      fail('COB_AMOUNT', 'billedMinor must be a positive integer of cents');
    }
    this.assertInstant(at);
    this.assertCoverages(input.coverages);
    const key = scoped(input.tenantId, input.episodeId);
    if (this.episodes.has(key)) fail('COB_DUPLICATE', 'episode is already open');
    const episode: MutableEpisode = {
      input: { ...input, coverages: [...input.coverages] },
      order: deriveCobOrder(input, msp),
      state: 'ready',
      position: 0,
      balanceMinor: input.billedMinor,
      priorPayers: [],
      submissions: [],
      awaitingCrossoverSince: null,
      crossoverPositions: new Set(),
      adjudicatedPositions: new Set(),
    };
    this.episodes.set(key, episode);
    this.record(input, at, 'opened', episode.order.basis);
    return this.view(episode);
  }

  /** Re-derives the order after a coverage or MSP change (REQ-RCM-042). Only before any claim. */
  public resequence(
    tenantId: string,
    episodeId: string,
    coverages: readonly Coverage[],
    msp: Wp054MspDetermination | null,
    at: string,
  ): CobEpisode {
    const episode = this.require(tenantId, episodeId);
    this.assertInstant(at);
    if (episode.state !== 'ready' || episode.submissions.length > 0) {
      fail('COB_RESEQUENCE', 'payer order can change only before the first claim is sent');
    }
    this.assertCoverages(coverages);
    const input: EpisodeInput = { ...episode.input, coverages: [...coverages] };
    episode.order = deriveCobOrder(input, msp);
    episode.input = input;
    this.record(input, at, 'resequenced', episode.order.basis);
    return this.view(episode);
  }

  /** Every reason a claim to `payerId` must not be sent now. Empty means it may be sent. */
  public preSubmissionCheck(
    tenantId: string,
    episodeId: string,
    payerId: string,
  ): readonly CobFinding[] {
    const episode = this.require(tenantId, episodeId);
    const { order, position, state } = episode;
    if (isCobTerminal(state)) {
      return [{ flag: 'episode-closed', detail: `episode is ${state}` }];
    }
    const findings: CobFinding[] = [...order.blocking];
    const target = order.payers.find((payer) => payer.payerId === payerId);
    if (target === undefined) {
      findings.push({ flag: 'unknown-payer', detail: `${payerId} is not in the payer order` });
      return findings;
    }
    const expected = order.payers[position];
    if (state === 'awaiting-crossover' && target.position === position) {
      findings.push({
        flag: 'crossover-pending',
        detail: `Medicare forwarded this claim to ${payerId}; a manual claim would duplicate it`,
      });
      return findings;
    }
    if (
      target.position > position ||
      (target.position === position && state !== 'ready' && state !== 'crossover-missing')
    ) {
      if (target.position > position) {
        findings.push({
          flag: 'secondary-before-primary-adjudicated',
          detail: `${payerId} is payer ${String(target.position + 1)}; payer ${String(position + 1)} (${expected?.payerId ?? 'none'}) has not adjudicated`,
        });
      }
      findings.push({
        flag: 'mis-ordered',
        detail: `next claim goes to ${expected?.payerId ?? 'none'} in state ${state}, not ${payerId}`,
      });
      return findings;
    }
    if (target.position < position) {
      findings.push({
        flag: 'mis-ordered',
        detail: `${payerId} already adjudicated as payer ${String(target.position + 1)}`,
      });
    }
    return findings;
  }

  public submit(
    tenantId: string,
    episodeId: string,
    request: SubmissionRequest,
  ): CobClaimSubmission {
    const episode = this.require(tenantId, episodeId);
    this.assertInstant(request.at);
    if (!TOKEN.test(request.controlNumber)) fail('COB_INPUT', 'controlNumber must be a token');
    const findings = this.preSubmissionCheck(tenantId, episodeId, request.payerId);
    if (findings.length > 0) {
      this.record(
        episode.input,
        request.at,
        'submission-refused',
        `${request.payerId}: ${findings.map((f) => f.flag).join(',')}`,
      );
      throw new CobSubmissionRefused(findings);
    }
    const controlKey = scoped(tenantId, request.controlNumber);
    if (this.controlNumbers.has(controlKey)) fail('COB_DUPLICATE', 'control number already used');
    assertCobTransition(episode.state, 'submitted');
    this.controlNumbers.add(controlKey);
    const submission: CobClaimSubmission = Object.freeze({
      episodeId,
      tenantId,
      position: episode.position,
      payerId: request.payerId,
      controlNumber: request.controlNumber,
      amountMinor: episode.balanceMinor,
      priorPayers: Object.freeze([...episode.priorPayers]),
      submittedAt: request.at,
    });
    episode.submissions.push(submission);
    episode.state = 'submitted';
    this.record(
      episode.input,
      request.at,
      'submitted',
      `${request.payerId} payer ${String(episode.position + 1)}`,
    );
    return submission;
  }

  /**
   * Applies a remit that WP-089 has posted, in the remit's own tenant. Duplicate and unexpected
   * remits are never posted.
   */
  public postRemit(remit: Wp089PostedRemit): RemitOutcome {
    assertRemitBalances(remit);
    this.assertInstant(remit.postedAt);
    const episode = this.require(remit.tenantId, remit.episodeId);
    if (remit.billedMinor !== episode.input.billedMinor) {
      return this.refuse(remit, 'billed amount differs from the episode charge');
    }
    const payer = episode.order.payers.find((p) => p.payerId === remit.payerId);
    if (payer === undefined)
      return this.refuse(remit, `${remit.payerId} is not in the payer order`);
    const remitKey = scoped(remit.tenantId, remit.remitId);
    if (this.remitIds.has(remitKey) || episode.adjudicatedPositions.has(payer.position)) {
      this.record(
        remit,
        remit.postedAt,
        'duplicate-remit',
        `${remit.remitId} from ${remit.payerId} payer ${String(payer.position + 1)} already adjudicated`,
      );
      return {
        status: 'duplicate',
        reason: `payer ${String(payer.position + 1)} already adjudicated`,
      };
    }
    if (payer.position !== episode.position) {
      return this.refuse(
        remit,
        `remit from payer ${String(payer.position + 1)} while payer ${String(episode.position + 1)} is open`,
      );
    }
    const viaCrossover = episode.crossoverPositions.has(episode.position);
    const current = episode.submissions.find((s) => s.position === episode.position);
    const matchesClaim = current?.controlNumber === remit.controlNumber;
    const accepts =
      (episode.state === 'submitted' && (matchesClaim || viaCrossover)) ||
      ((episode.state === 'awaiting-crossover' || episode.state === 'crossover-missing') &&
        viaCrossover);
    if (!accepts) {
      return this.refuse(remit, `no open claim to ${remit.payerId} in state ${episode.state}`);
    }

    assertCobTransition(episode.state, 'adjudicated');
    this.remitIds.add(remitKey);
    episode.adjudicatedPositions.add(payer.position);
    episode.state = 'adjudicated';
    episode.awaitingCrossoverSince = null;
    episode.priorPayers.push(
      Object.freeze({
        position: payer.position,
        payerId: remit.payerId,
        remitId: remit.remitId,
        paidMinor: remit.paidMinor,
        adjustments: Object.freeze([...remit.adjustments]),
      }),
    );
    episode.balanceMinor = patientResponsibility(remit);
    this.record(
      remit,
      remit.postedAt,
      'adjudicated',
      `${remit.payerId} paid ${String(remit.paidMinor)}; balance ${String(episode.balanceMinor)}`,
    );
    this.advance(episode, remit);
    return { status: 'posted', state: episode.state };
  }

  /** Moves an expired crossover wait to `crossover-missing`, releasing a manual claim (REQ-RCM-043). */
  public checkCrossover(tenantId: string, episodeId: string, today: string): CobState {
    const episode = this.require(tenantId, episodeId);
    if (!DAY.test(today)) fail('COB_INPUT', 'today must be YYYY-MM-DD');
    if (episode.state !== 'awaiting-crossover' || episode.awaitingCrossoverSince === null) {
      return episode.state;
    }
    const waited = daysBetween(episode.awaitingCrossoverSince, today);
    if (waited > CROSSOVER_WINDOW_DAYS) {
      assertCobTransition(episode.state, 'crossover-missing');
      episode.state = 'crossover-missing';
      const payer = episode.order.payers[episode.position];
      this.record(
        episode.input,
        `${today}T00:00:00Z`,
        'crossover-missing',
        `${payer?.payerId ?? 'unknown'} silent for ${String(waited)} days`,
      );
    }
    return episode.state;
  }

  public episode(tenantId: string, episodeId: string): CobEpisode {
    return this.view(this.require(tenantId, episodeId));
  }

  /** A tenant's events, optionally for one episode. Never another tenant's. */
  public events(tenantId: string, episodeId?: string): readonly CobEvent[] {
    return this.log.filter(
      (e) => e.tenantId === tenantId && (episodeId === undefined || e.episodeId === episodeId),
    );
  }

  private advance(episode: MutableEpisode, remit: Wp089PostedRemit): void {
    const ref = episode.input;
    const current = episode.order.payers[episode.position];
    const next = episode.order.payers[episode.position + 1];
    if (next === undefined || episode.balanceMinor === 0) {
      if (remit.forwardedToPayerId !== null) {
        this.toException(
          episode,
          remit.postedAt,
          `remit forwarded to ${remit.forwardedToPayerId} but no balance or next payer remains`,
        );
        return;
      }
      assertCobTransition(episode.state, 'complete');
      episode.state = 'complete';
      this.record(
        ref,
        remit.postedAt,
        'completed',
        `balance ${String(episode.balanceMinor)} after payer ${String(episode.position + 1)}`,
      );
      return;
    }
    if (remit.forwardedToPayerId !== null) {
      if (remit.forwardedToPayerId !== next.payerId || !next.crossoverEligible) {
        this.toException(
          episode,
          remit.postedAt,
          `crossover went to ${remit.forwardedToPayerId}; next payer is ${next.payerId} (crossover ${next.crossoverEligible ? 'eligible' : 'not eligible'})`,
        );
        return;
      }
      assertCobTransition(episode.state, 'awaiting-crossover');
      episode.position += 1;
      episode.state = 'awaiting-crossover';
      episode.crossoverPositions.add(episode.position);
      episode.awaitingCrossoverSince = dayOf(remit.postedAt);
      this.record(ref, remit.postedAt, 'crossover-forwarded', `to ${next.payerId}`);
      return;
    }
    const medicareFirst = current?.kind === 'medicare';
    if (medicareFirst && next.crossoverEligible) {
      this.record(
        ref,
        remit.postedAt,
        'crossover-not-forwarded',
        `${next.payerId} expected a crossover; manual claim released`,
      );
    }
    assertCobTransition(episode.state, 'ready');
    episode.position += 1;
    episode.state = 'ready';
  }

  private toException(episode: MutableEpisode, at: string, detail: string): void {
    assertCobTransition(episode.state, 'exception');
    episode.state = 'exception';
    this.record(episode.input, at, 'exception', detail);
  }

  private refuse(remit: Wp089PostedRemit, reason: string): RemitOutcome {
    this.record(remit, remit.postedAt, 'exception', `remit ${remit.remitId} refused: ${reason}`);
    return { status: 'refused', reason };
  }

  private assertCoverages(coverages: readonly Coverage[]): void {
    const ids = new Set<string>();
    for (const coverage of coverages) {
      if (!TOKEN.test(coverage.coverageId) || !TOKEN.test(coverage.payerId)) {
        fail('COB_COVERAGE', 'coverageId and payerId must be tokens');
      }
      if (
        !DAY.test(coverage.effectiveFrom) ||
        (coverage.effectiveTo !== null && !DAY.test(coverage.effectiveTo))
      ) {
        fail('COB_COVERAGE', 'coverage dates must be YYYY-MM-DD');
      }
      if (ids.has(coverage.coverageId))
        fail('COB_COVERAGE', `duplicate coverage ${coverage.coverageId}`);
      ids.add(coverage.coverageId);
    }
  }

  private assertInstant(at: string): void {
    if (!INSTANT.test(at)) fail('COB_TIME', 'timestamps must be UTC ISO-8601');
  }

  private require(tenantId: string, episodeId: string): MutableEpisode {
    const episode = this.episodes.get(scoped(tenantId, episodeId));
    if (episode === undefined) fail('COB_UNKNOWN_EPISODE', `no COB episode ${episodeId}`);
    return episode;
  }

  private record(ref: EpisodeRef, at: string, kind: CobEvent['kind'], detail: string): void {
    this.log.push(
      Object.freeze({ tenantId: ref.tenantId, episodeId: ref.episodeId, at, kind, detail }),
    );
  }

  private view(episode: MutableEpisode): CobEpisode {
    return Object.freeze({
      input: episode.input,
      order: episode.order,
      state: episode.state,
      position: episode.position,
      balanceMinor: episode.balanceMinor,
      priorPayers: [...episode.priorPayers],
      submissions: [...episode.submissions],
      awaitingCrossoverSince: episode.awaitingCrossoverSince,
    });
  }
}
