import { createHash } from 'node:crypto';

import { RcmShadowError } from '../contracts.js';
import type { EraRegistry, EraRoutable, EraSystem } from './era-registry.js';
import {
  StatementNotSentError,
  type StatementIssuerPort,
  type StatementReceipt,
} from './statement-port.js';

export type BalanceEventKind =
  | 'patient-responsibility'
  | 'patient-payment'
  | 'patient-refund'
  | 'adjustment'
  | 'takeback'
  | 'appeal-resolution';

/** One patient-balance event. A positive amount raises what the patient owes. */
export interface BalanceEvent extends EraRoutable {
  readonly eventId: string;
  readonly accountRef: string;
  readonly episodeId: string;
  readonly kind: BalanceEventKind;
  readonly amountMinor: number;
}

export interface ApplyResult {
  readonly status: 'applied' | 'forwarded' | 'duplicate';
  readonly owner: EraSystem;
  readonly crossEra: boolean;
}

export interface ForwardedEvent {
  readonly event: BalanceEvent;
  readonly owner: 'legacy';
  readonly crossEra: boolean;
}

/**
 * issued: sent now. already-stated: this balance was stated before.
 * no-balance: nothing owed. legacy-stated: the legacy system stated it.
 * unconfirmed: an earlier issue may have reached the patient; held for a human.
 * not-sent: the issuer reported a definite non-delivery; nothing is held and the next run sends.
 */
export type StatementStatus =
  'issued' | 'already-stated' | 'no-balance' | 'legacy-stated' | 'unconfirmed' | 'not-sent';

export interface StatementOutcome {
  readonly tenantId: string;
  readonly accountRef: string;
  readonly episodeId: string;
  readonly amountMinor: number;
  readonly status: StatementStatus;
  readonly statementId: string | null;
}

export interface BalanceException {
  readonly reason: 'dual-statement-risk' | 'statement-unconfirmed';
  readonly tenantId: string;
  readonly accountRef: string;
  readonly episodeId: string;
  readonly owner: string;
}

export interface PatientBalanceBookOptions {
  readonly registry: EraRegistry;
  readonly issuer: StatementIssuerPort;
  readonly exceptionOwner?: string;
  /** Test hook between the issuer call and the book's record of it. */
  readonly afterIssue?: (statementId: string) => void;
}

/** A statement the book decided to send, recorded before the issuer is called. */
interface StatementIntent {
  readonly statementId: string;
  readonly amountMinor: number;
}

interface Episode {
  readonly tenantId: string;
  readonly accountRef: string;
  readonly episodeId: string;
  readonly owner: EraSystem;
  balanceMinor: number;
  statements: number;
  lastStatedMinor: number | null;
  intent: StatementIntent | null;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function episodeKey(tenantId: string, accountRef: string, episodeId: string): string {
  return `${tenantId}\u001f${accountRef}\u001f${episodeId}`;
}

/**
 * WP-090 patient balances and statements.
 *
 * Each episode is owned by exactly one system, fixed by the era registry at
 * the episode's first event. Events for a legacy-owned episode are
 * forwarded and never change a native balance, whichever rail they arrived
 * on. Only the owner states a balance, and a balance already stated is not
 * stated again until it has been paid down to zero or less.
 *
 * The book owns the single-statement guarantee across a crash: it records a
 * statement intent before calling the issuer. A retry that finds an
 * unconfirmed intent resends only through an issuer that is idempotent by
 * statement id; otherwise the episode is held for a human to confirm.
 */
export class PatientBalanceBook {
  private readonly episodes = new Map<string, Episode>();
  private readonly seenEvents = new Set<string>();
  private readonly forwardedEvents: ForwardedEvent[] = [];
  private readonly legacyStated = new Set<string>();
  private readonly open: BalanceException[] = [];
  private readonly owner: string;

  public constructor(private readonly options: PatientBalanceBookOptions) {
    this.owner = options.exceptionOwner ?? 'rcm-lead';
  }

  public apply(event: BalanceEvent): ApplyResult {
    for (const field of ['eventId', 'tenantId', 'accountRef', 'episodeId', 'payerId'] as const) {
      if (!TOKEN.test(event[field])) {
        throw new RcmShadowError('BALANCE_INVALID', `${field} must be a token`);
      }
    }
    if (!Number.isSafeInteger(event.amountMinor)) {
      throw new RcmShadowError('BALANCE_INVALID', 'amountMinor must be a safe integer');
    }
    const routed = this.options.registry.route(event);
    const key = episodeKey(event.tenantId, event.accountRef, event.episodeId);
    const existing = this.episodes.get(key);
    const owner = existing?.owner ?? routed.owner;
    const crossEra = owner !== event.arrivedVia;
    const eventKey = `${event.tenantId}\u001f${event.eventId}`;
    if (this.seenEvents.has(eventKey)) {
      return { status: 'duplicate', owner, crossEra };
    }
    // Every fallible step runs before anything is committed, so a failed apply can be retried.
    const next = owner === 'native' ? (existing?.balanceMinor ?? 0) + event.amountMinor : 0;
    if (!Number.isSafeInteger(next)) {
      throw new RcmShadowError('BALANCE_INVALID', 'balance overflows');
    }
    const episode: Episode = existing ?? {
      tenantId: event.tenantId,
      accountRef: event.accountRef,
      episodeId: event.episodeId,
      owner,
      balanceMinor: 0,
      statements: 0,
      lastStatedMinor: null,
      intent: null,
    };
    this.episodes.set(key, episode);
    this.seenEvents.add(eventKey);
    if (owner === 'legacy') {
      this.forwardedEvents.push({ event: structuredClone(event), owner: 'legacy', crossEra });
      return { status: 'forwarded', owner, crossEra };
    }
    episode.balanceMinor = next;
    if (next <= 0) {
      // Paid down: whatever is owed next is a new balance, even at the old amount.
      episode.lastStatedMinor = null;
    }
    return { status: 'applied', owner, crossEra };
  }

  /** The native balance for an episode; a legacy-owned episode is always zero here. */
  public balance(tenantId: string, accountRef: string, episodeId: string): number {
    const episode = this.episodes.get(episodeKey(tenantId, accountRef, episodeId));
    return episode?.owner === 'native' ? episode.balanceMinor : 0;
  }

  public ownerOf(tenantId: string, accountRef: string, episodeId: string): EraSystem | null {
    return this.episodes.get(episodeKey(tenantId, accountRef, episodeId))?.owner ?? null;
  }

  /** Events handed to the legacy system instead of posting here. */
  public forwarded(): readonly ForwardedEvent[] {
    return this.forwardedEvents.map((item) => structuredClone(item));
  }

  /** Records that the legacy system already stated this episode. */
  public recordLegacyStatement(tenantId: string, accountRef: string, episodeId: string): void {
    this.legacyStated.add(episodeKey(tenantId, accountRef, episodeId));
  }

  /**
   * Resolves an unconfirmed statement after a human checked delivery:
   * `delivered` records it as stated; otherwise the next run sends it.
   */
  public resolveUnconfirmed(
    tenantId: string,
    accountRef: string,
    episodeId: string,
    delivered: boolean,
  ): void {
    const episode = this.episodes.get(episodeKey(tenantId, accountRef, episodeId));
    if (!episode?.intent) {
      throw new RcmShadowError('STATEMENT_STATE', 'no unconfirmed statement for this episode');
    }
    if (delivered) {
      this.recordStated(episode, episode.intent);
    } else {
      episode.intent = null;
    }
  }

  public runStatements(tenantId: string, issueOn: string): readonly StatementOutcome[] {
    const outcomes: StatementOutcome[] = [];
    const episodes = [...this.episodes.entries()]
      .filter(([, episode]) => episode.tenantId === tenantId && episode.owner === 'native')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    for (const [key, episode] of episodes) {
      const base = {
        tenantId: episode.tenantId,
        accountRef: episode.accountRef,
        episodeId: episode.episodeId,
        amountMinor: episode.balanceMinor,
      };
      let intent: StatementIntent;
      if (episode.intent !== null) {
        if (!this.options.issuer.idempotent) {
          // An earlier issue may have reached the patient; resending could state the balance twice.
          this.openOnce('statement-unconfirmed', episode);
          outcomes.push({
            ...base,
            status: 'unconfirmed',
            statementId: episode.intent.statementId,
          });
          continue;
        }
        // The issuer dedupes by statement id, so resending the recorded intent is safe.
        intent = episode.intent;
      } else {
        if (episode.balanceMinor <= 0) {
          episode.lastStatedMinor = null;
          outcomes.push({ ...base, status: 'no-balance', statementId: null });
          continue;
        }
        if (this.legacyStated.has(key)) {
          this.openOnce('dual-statement-risk', episode);
          outcomes.push({ ...base, status: 'legacy-stated', statementId: null });
          continue;
        }
        if (episode.lastStatedMinor === episode.balanceMinor) {
          outcomes.push({ ...base, status: 'already-stated', statementId: null });
          continue;
        }
        intent = {
          statementId: `stmt-${createHash('sha256')
            .update(
              `${key}\u001f${String(episode.statements)}\u001f${String(episode.balanceMinor)}`,
            )
            .digest('hex')
            .slice(0, 32)}`,
          amountMinor: episode.balanceMinor,
        };
        // Recorded before the issuer is called, so a crash leaves evidence of the attempt.
        episode.intent = intent;
      }
      // One issuer failure never aborts the run (NR-140). A definite non-delivery clears the
      // intent so the next run sends; any other failure leaves delivery unknown and is held.
      let receipt: StatementReceipt;
      try {
        receipt = this.options.issuer.issue({
          tenantId: episode.tenantId,
          accountRef: episode.accountRef,
          episodeId: episode.episodeId,
          statementId: intent.statementId,
          issueOn,
          amountMinor: intent.amountMinor,
        });
      } catch (error) {
        if (error instanceof StatementNotSentError) {
          episode.intent = null;
          outcomes.push({
            ...base,
            amountMinor: intent.amountMinor,
            status: 'not-sent',
            statementId: intent.statementId,
          });
        } else {
          this.openOnce('statement-unconfirmed', episode);
          outcomes.push({
            ...base,
            amountMinor: intent.amountMinor,
            status: 'unconfirmed',
            statementId: intent.statementId,
          });
        }
        continue;
      }
      // The crash hook stays outside the guard: a crash after issue must still leave the intent.
      this.options.afterIssue?.(intent.statementId);
      this.recordStated(episode, intent);
      outcomes.push({
        ...base,
        amountMinor: intent.amountMinor,
        status: receipt.replay ? 'already-stated' : 'issued',
        statementId: intent.statementId,
      });
    }
    return outcomes;
  }

  public exceptions(): readonly BalanceException[] {
    return [...this.open];
  }

  private recordStated(episode: Episode, intent: StatementIntent): void {
    episode.statements += 1;
    episode.lastStatedMinor = intent.amountMinor;
    episode.intent = null;
  }

  private openOnce(reason: BalanceException['reason'], episode: Episode): void {
    const exists = this.open.some(
      (item) =>
        item.reason === reason &&
        episodeKey(item.tenantId, item.accountRef, item.episodeId) ===
          episodeKey(episode.tenantId, episode.accountRef, episode.episodeId),
    );
    if (!exists) {
      this.open.push({
        reason,
        tenantId: episode.tenantId,
        accountRef: episode.accountRef,
        episodeId: episode.episodeId,
        owner: this.owner,
      });
    }
  }
}
