import { describe, expect, it } from 'vitest';

import { BalancedLedger } from './ledger.js';
import {
  creditBalanceDurationDays,
  creditBalanceEscalationLeadDays,
  DunningRegister,
  inMemoryCreditBalanceClockRegistry,
  registerCreditBalanceFromLedger,
  StatementError,
} from './statements.js';

const tenant = 'northwind-synthetic';

describe('[high] deceased stop on an account that already exists', () => {
  it('moves an active account to deceased + stopped in one step and refuses later notices', () => {
    const register = new DunningRegister();
    register.open(tenant, 'acct-1');
    expect(register.issueNotice(tenant, 'acct-1', 'notice-1')).toBe('notice-1');
    const stopped = register.recordDeceased(tenant, 'acct-1');
    expect(stopped).toMatchObject({
      deceased: true,
      dunning: 'stopped',
      stoppedReason: 'deceased',
    });
    expect(register.current(tenant, 'acct-1')).toEqual(stopped);
    expect(() => register.issueNotice(tenant, 'acct-1', 'notice-2')).toThrowError(
      new StatementError('DUNNING_STOPPED'),
    );
    expect(register.open(tenant, 'acct-1')).toEqual(stopped);
    expect(register.history(tenant, 'acct-1').map((entry) => entry.dunning)).toEqual([
      'active',
      'stopped',
    ]);
    expect(() => register.recordDeceased(tenant, 'acct-missing')).toThrowError(
      new StatementError('UNKNOWN_ACCOUNT'),
    );
  });
});

describe('[medium] a credit balance on the ledger registers exactly one clock', () => {
  it('opens one 60-day clock for an overpayment and none for a settled account', () => {
    const ledger = new BalancedLedger();
    const post = (
      journalId: string,
      lines: Parameters<BalancedLedger['postBalancedSet']>[0]['lines'],
    ) =>
      ledger.postBalancedSet({
        tenantId: tenant,
        journalId,
        correlationId: `c-${journalId}`,
        idempotencyKey: `k-${journalId}`,
        rail: 'cash',
        lines,
      });
    post('charge', [
      {
        accountRef: 'patient-ar:acct-1',
        side: 'debit',
        amountMinor: 2500,
        currency: 'USD',
        sourceRef: 'svc-1',
      },
      {
        accountRef: 'service-revenue',
        side: 'credit',
        amountMinor: 2500,
        currency: 'USD',
        sourceRef: 'svc-1',
      },
    ]);
    post('payment', [
      { accountRef: 'cash', side: 'debit', amountMinor: 2500, currency: 'USD', sourceRef: 'pay-1' },
      {
        accountRef: 'patient-ar:acct-1',
        side: 'credit',
        amountMinor: 2500,
        currency: 'USD',
        sourceRef: 'pay-1',
      },
    ]);
    const registry = inMemoryCreditBalanceClockRegistry();
    const input = {
      tenantId: tenant,
      accountRef: 'acct-1',
      receivableAccountRef: 'patient-ar:acct-1',
      currency: 'USD',
      at: '2026-01-10T00:00:00.000Z',
      clockId: 'clock-1',
    };
    expect(registerCreditBalanceFromLedger(ledger, registry, input)).toBeNull();

    post('overpayment', [
      { accountRef: 'cash', side: 'debit', amountMinor: 400, currency: 'USD', sourceRef: 'pay-2' },
      {
        accountRef: 'patient-ar:acct-1',
        side: 'credit',
        amountMinor: 400,
        currency: 'USD',
        sourceRef: 'pay-2',
      },
    ]);
    const first = registerCreditBalanceFromLedger(ledger, registry, input);
    expect(first?.created).toBe(true);
    expect(first?.clock).toMatchObject({
      accountRef: 'acct-1',
      amountMinor: 400,
      durationDays: creditBalanceDurationDays,
      dueAt: '2026-03-11T00:00:00.000Z',
      escalateAt: '2026-02-25T00:00:00.000Z',
    });
    expect(creditBalanceEscalationLeadDays).toBe(14);
    const again = registerCreditBalanceFromLedger(ledger, registry, {
      ...input,
      clockId: 'clock-2',
    });
    expect(again?.created).toBe(false);
    expect(registry.clocks(tenant)).toHaveLength(1);
    expect(registry.clocks('riverbend-synthetic')).toHaveLength(0);
  });
});
