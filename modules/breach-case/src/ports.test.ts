import { describe, expect, it } from 'vitest';

import { openBreachCase } from './breach-case.js';
import {
  consumeGeneticElevation,
  openBreachCaseDependencies,
  reconcileNotice,
  sendHumanApprovedNotice,
} from './ports.js';
import { RecordingBreachAuditPortV1 } from './testing/recording-breach-audit-port.js';
import { RecordingBreachClockPortV1 } from './testing/recording-breach-clock-port.js';
import { RecordingBreachNotificationPortV1 } from './testing/recording-breach-notification-port.js';
import { RecordingGeneticElevationSourceV1 } from './testing/recording-genetic-elevation-source.js';

function opened() {
  return openBreachCase({
    tenantId: 'northwind-synthetic',
    caseId: 'port-case-1',
    sourceKind: 'audit-anomaly',
    sourceRef: 'incident:port-1',
    incidentAt: '2026-03-01T10:00:00Z',
    discoveryAt: '2026-03-02T10:00:00Z',
    ownerRef: 'compliance:officer',
    actorRef: 'system:intake',
    eventKey: 'port-open-1',
  });
}

const duty = {
  dutyId: 'floor-duty',
  clockId: 'clock:floor',
  jurisdiction: 'floor' as const,
  contributionFact: 'floor' as const,
  policyVersion: 7,
  policyEffectiveOn: '2026-01-01',
  policyRef: 'policy:provider-v7',
  dueAt: '2026-05-01T10:00:00Z',
  escalationAt: '2026-04-24T10:00:00Z',
  requiredAudiences: ['individual'] as const,
  status: 'open' as const,
  completionEvidenceRef: null,
  synthetic: true as const,
};

describe('literal v1 recording ports', () => {
  it('passes discovery and preserves provider policy/due facts verbatim', async () => {
    const clocks = new RecordingBreachClockPortV1([duty]);
    const audit = new RecordingBreachAuditPortV1({
      subjectRefs: ['person:synthetic-1'],
      queryEvidenceRef: 'audit-query:port-1',
      complete: true,
      limitationRef: null,
    });
    const result = await openBreachCaseDependencies(
      opened(),
      { clocks, audit },
      {
        providerState: 'PA',
        affectedPatientStates: ['NY', 'PA', 'NY'],
        actorRef: 'compliance:officer',
        windowStart: '2026-03-01T00:00:00Z',
        windowEnd: '2026-03-02T10:00:00Z',
        occurredAt: '2026-03-02T11:00:00Z',
        idempotencyKey: 'port-deps-1',
      },
    );
    expect(clocks.version).toBe('v1');
    expect(clocks.opened[0]).toMatchObject({
      discoveryAt: '2026-03-02T10:00:00Z',
      affectedPatientStates: ['NY', 'PA'],
    });
    expect(result.duties[0]).toEqual(duty);
    expect(result.retentionEvidenceRef).toBe('retention:port-case-1');
  });

  it('keeps accepted transport nonterminal until explicit reconciliation', async () => {
    const withDuty = await openBreachCaseDependencies(
      opened(),
      {
        clocks: new RecordingBreachClockPortV1([duty]),
        audit: new RecordingBreachAuditPortV1({
          subjectRefs: [],
          queryEvidenceRef: 'audit-query:port-2',
          complete: true,
          limitationRef: null,
        }),
      },
      {
        providerState: null,
        affectedPatientStates: [],
        actorRef: 'compliance:officer',
        windowStart: '2026-03-01T00:00:00Z',
        windowEnd: '2026-03-02T10:00:00Z',
        occurredAt: '2026-03-02T11:00:00Z',
        idempotencyKey: 'port-deps-2',
      },
    );
    const notifications = new RecordingBreachNotificationPortV1(
      { state: 'accepted', terminalEvidenceRef: null },
      { state: 'delivered', terminalEvidenceRef: 'receipt:port-delivered' },
    );
    let persistedState: string | undefined;
    const accepted = await sendHumanApprovedNotice(withDuty, notifications, {
      tenantId: withDuty.tenantId,
      caseId: withDuty.caseId,
      dutyId: duty.dutyId,
      audience: 'individual',
      preparedBy: 'person:author',
      preparedAt: '2026-03-03T09:00:00Z',
      templateRef: 'template:individual-v1',
      idempotencyKey: 'port-notice-1',
      approvedBy: 'person:approver',
      approvedAt: '2026-03-03T10:00:00Z',
      persistEffectIntent: async (aggregate) => {
        persistedState = aggregate.notices[0]?.state;
      },
    });
    expect(persistedState).toBe('effect-intended');
    const current = accepted.notices[0];
    if (current === undefined || current.effectKey === null) {
      throw new Error('accepted notice with effect key missing');
    }
    expect(current.state).toBe('accepted');
    expect(current.terminalEvidenceRef).toBeNull();
    const delivered = await reconcileNotice(accepted, notifications, {
      tenantId: accepted.tenantId,
      caseId: accepted.caseId,
      noticeId: current.noticeId,
      effectKey: current.effectKey,
      receiptEventKey: 'port-notice-receipt-1',
      observedAt: '2026-03-03T10:02:00Z',
      actorRef: 'system:reconciler',
    });
    expect(delivered.notices[0]?.state).toBe('delivered');
    expect(delivered.notices[0]?.terminalEvidenceRef).toBe('receipt:port-delivered');
  });

  it('retains a legal direct-delivered provider result after one persisted effect intent', async () => {
    const withDuty = await openBreachCaseDependencies(
      opened(),
      {
        clocks: new RecordingBreachClockPortV1([duty]),
        audit: new RecordingBreachAuditPortV1({
          subjectRefs: [],
          queryEvidenceRef: 'audit-query:direct',
          complete: true,
          limitationRef: null,
        }),
      },
      {
        providerState: null,
        affectedPatientStates: [],
        actorRef: 'compliance:officer',
        windowStart: '2026-03-01T00:00:00Z',
        windowEnd: '2026-03-02T10:00:00Z',
        occurredAt: '2026-03-02T11:00:00Z',
        idempotencyKey: 'port-direct-deps',
      },
    );
    const notifications = new RecordingBreachNotificationPortV1({
      state: 'delivered',
      terminalEvidenceRef: 'receipt:direct-delivery',
    });
    let persisted = 0;
    const result = await sendHumanApprovedNotice(withDuty, notifications, {
      tenantId: withDuty.tenantId,
      caseId: withDuty.caseId,
      dutyId: duty.dutyId,
      audience: 'individual',
      preparedBy: 'person:author',
      preparedAt: '2026-03-03T09:00:00Z',
      templateRef: 'template:individual-v1',
      idempotencyKey: 'direct-notice',
      approvedBy: 'person:approver',
      approvedAt: '2026-03-03T10:00:00Z',
      persistEffectIntent: async () => {
        persisted += 1;
      },
    });
    expect(persisted).toBe(1);
    expect(notifications.sent).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({
      state: 'delivered',
      terminalEvidenceRef: 'receipt:direct-delivery',
    });
  });

  it('rejects aggregate/input correlation before invoking the notification provider', async () => {
    const notifications = new RecordingBreachNotificationPortV1({
      state: 'accepted',
      terminalEvidenceRef: null,
    });
    await expect(
      sendHumanApprovedNotice(opened(), notifications, {
        tenantId: 'riverbend-synthetic',
        caseId: 'other-case',
        dutyId: 'floor-duty',
        audience: 'individual',
        preparedBy: 'person:author',
        preparedAt: '2026-03-03T09:00:00Z',
        templateRef: 'template:individual-v1',
        idempotencyKey: 'wrong-tuple',
        approvedBy: 'person:approver',
        approvedAt: '2026-03-03T10:00:00Z',
        persistEffectIntent: async () => undefined,
      }),
    ).rejects.toThrow(/tenant\/case mismatch/);
    expect(notifications.prepared).toHaveLength(0);
    expect(notifications.sent).toHaveLength(0);
  });

  it('consumes only the exact genetic elevation source and keeps its supplied deadline', async () => {
    const record = {
      tenantId: 'northwind-synthetic',
      sourceEventKey: 'port-genetic-1',
      grantRef: 'grant:bg-1',
      auditRef: 'audit:bg-1',
      workItemRef: 'work-item:bg-1',
      accessorRef: 'person:accessor',
      initiatorRef: 'person:initiator',
      subjectRef: 'person:subject',
      severity: 'elevated-genetic' as const,
      partitionTags: ['gipa-genetic'],
      reviewDueAt: '2026-03-04T10:00:00Z',
      occurredAt: '2026-03-02T10:00:00Z',
      synthetic: true as const,
    };
    const source = new RecordingGeneticElevationSourceV1(
      new Map([[record.sourceEventKey, record]]),
    );
    const result = await consumeGeneticElevation(
      opened(),
      source,
      record.sourceEventKey,
      'system:consumer',
    );
    expect(result.geneticReviews[0]).toMatchObject({
      reviewDueAt: record.reviewDueAt,
      risk: 'critical',
    });
    expect(source.reads).toEqual([record.sourceEventKey]);
    const changedTime = new RecordingGeneticElevationSourceV1(
      new Map([[record.sourceEventKey, { ...record, occurredAt: '2026-03-01T10:00:00Z' }]]),
    );
    await expect(
      consumeGeneticElevation(result, changedTime, record.sourceEventKey, 'system:consumer'),
    ).rejects.toThrow(/changed correlation/);
  });

  it('rejects mismatched and non-synthetic genetic source records', async () => {
    const base = {
      tenantId: 'northwind-synthetic',
      sourceEventKey: 'returned-other-key',
      grantRef: 'grant:bg-1',
      auditRef: 'audit:bg-1',
      workItemRef: 'work-item:bg-1',
      accessorRef: 'person:accessor',
      initiatorRef: 'person:initiator',
      subjectRef: 'person:subject',
      severity: 'elevated-genetic' as const,
      partitionTags: ['gipa-genetic'],
      reviewDueAt: '2026-03-04T10:00:00Z',
      occurredAt: '2026-03-02T10:00:00Z',
      synthetic: true as const,
    };
    const mismatch = new RecordingGeneticElevationSourceV1(new Map([['requested-key', base]]));
    await expect(
      consumeGeneticElevation(opened(), mismatch, 'requested-key', 'system:consumer'),
    ).rejects.toThrow(/requested key/);
    const unwatermarked = new RecordingGeneticElevationSourceV1(
      new Map([
        ['requested-key', { ...base, sourceEventKey: 'requested-key', synthetic: false as true }],
      ]),
    );
    await expect(
      consumeGeneticElevation(opened(), unwatermarked, 'requested-key', 'system:consumer'),
    ).rejects.toThrow(/synthetic/);
  });
});
