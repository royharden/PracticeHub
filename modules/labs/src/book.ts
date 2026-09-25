import {
  assertPhClinicalResource,
  PH_CLINICAL_CONTRACT_VERSION,
} from '@practicehub/clinical-contracts';
import type { PhClinicalResource } from '@practicehub/clinical-contracts';
import { applyWorkItemEvent, initialWorkItem } from '@practicehub/events';
import type { WorkItem, WorkItemEvent } from '@practicehub/events';

import { LabError } from './errors.js';
import type {
  CriticalClosure,
  DeviceCalibration,
  ExpectedResultAge,
  LabOrder,
  LabResult,
  ReadBack,
  RecallCohort,
  Reconciliation,
  ReconciliationState,
} from './types.js';

const idPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function requireSynthetic(synthetic: boolean): asserts synthetic is true {
  if (synthetic !== true) {
    throw new LabError('LAB_SYNTHETIC', 'labs accepts synthetic facts only');
  }
}

function requireId(value: string, label: string): string {
  if (!idPattern.test(value)) {
    throw new LabError('LAB_ID', `${label} must match ${idPattern.source}`);
  }
  return value;
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new LabError('LAB_TEXT', `${label} must be 1..200 characters`);
  }
  return trimmed;
}

function requireInstant(value: string, label: string): string {
  if (!instantPattern.test(value) || Number.isNaN(Date.parse(value))) {
    throw new LabError('LAB_INSTANT', `${label} must be a UTC instant`);
  }
  return value;
}

function instantMs(value: string): number {
  return Date.parse(value);
}

function key(tenantId: string, id: string): string {
  return `${tenantId}\u0000${id}`;
}

function resource(input: {
  readonly resourceType: 'ServiceRequest' | 'Observation' | 'DiagnosticReport';
  readonly id: string;
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly code: string;
  readonly display: string;
}): PhClinicalResource {
  const built: PhClinicalResource = {
    resourceType: input.resourceType,
    id: input.id,
    tenantId: input.tenantId,
    subjectRef: input.subjectRef,
    sourceVersion: PH_CLINICAL_CONTRACT_VERSION,
    coding: { system: 'http://loinc.org', code: input.code, display: input.display },
    synthetic: true,
  };
  assertPhClinicalResource(built);
  return built;
}

function openWorkItem(input: {
  readonly workItemId: string;
  readonly subjectRef: string;
  readonly purpose: 'lab.critical-closure' | 'lab.expected-result-aging';
  readonly risk: 'critical' | 'elevated';
  readonly poolId: 'lab-critical-results' | 'lab-expected-results';
  readonly openedAt: string;
  readonly responseDueAt: string;
}): WorkItem {
  return initialWorkItem({
    workItemId: input.workItemId,
    origin: 'admin',
    subjectRef: input.subjectRef,
    purpose: input.purpose,
    risk: input.risk,
    serviceTier: 'synthetic',
    slaPolicyId: null,
    policyVersion: null,
    responseDueAt: input.responseDueAt,
    poolId: input.poolId,
    openedAt: input.openedAt,
  });
}

function withEvent(item: WorkItem, event: WorkItemEvent): WorkItem {
  return applyWorkItemEvent(item, event);
}

export class LabBook {
  readonly #orders = new Map<string, LabOrder>();
  readonly #results = new Map<string, LabResult>();
  readonly #closures = new Map<string, CriticalClosure>();
  readonly #ages = new Map<string, ExpectedResultAge>();
  readonly #reconciliations = new Map<string, Reconciliation>();
  readonly #recalls = new Map<string, RecallCohort>();

  placeOrder(input: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly subjectRef: string;
    readonly code: string;
    readonly display: string;
    readonly orderedAt: string;
    readonly expectedResultBy: string;
    readonly synthetic: true;
  }): LabOrder {
    requireSynthetic(input.synthetic);
    const tenantId = requireId(input.tenantId, 'tenantId');
    const orderId = requireId(input.orderId, 'orderId');
    const subjectRef = requireId(input.subjectRef, 'subjectRef');
    const code = requireText(input.code, 'code');
    const display = requireText(input.display, 'display');
    const orderedAt = requireInstant(input.orderedAt, 'orderedAt');
    const expectedResultBy = requireInstant(input.expectedResultBy, 'expectedResultBy');
    if (instantMs(expectedResultBy) <= instantMs(orderedAt)) {
      throw new LabError('LAB_INSTANT', 'expectedResultBy must be after orderedAt');
    }
    const orderKey = key(tenantId, orderId);
    if (this.#orders.has(orderKey)) {
      throw new LabError('LAB_DUPLICATE', `order ${orderId} already exists`);
    }
    const order: LabOrder = {
      orderId,
      tenantId,
      subjectRef,
      code,
      display,
      orderedAt,
      expectedResultBy,
      serviceRequest: resource({
        resourceType: 'ServiceRequest',
        id: orderId,
        tenantId,
        subjectRef,
        code,
        display,
      }),
      status: 'awaiting-result',
      currentResultId: null,
      synthetic: true,
    };
    this.#orders.set(orderKey, order);
    return order;
  }

  recordElectronicResult(input: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly resultId: string;
    readonly value: string;
    readonly critical: boolean;
    readonly recordedAt: string;
    readonly synthetic: true;
  }): LabResult {
    requireSynthetic(input.synthetic);
    const order = this.#requireOrder(input.tenantId, input.orderId);
    this.#requireNoResults(order);
    const result = this.#putResult({
      tenantId: order.tenantId,
      order,
      resultId: input.resultId,
      value: input.value,
      critical: input.critical,
      recordedAt: input.recordedAt,
      source: 'electronic',
      provisional: false,
      reconciliation: 'not-applicable',
      supersedesResultId: null,
      readBack: null,
      calibration: null,
    });
    this.#replaceOrder(order, { status: 'resulted', currentResultId: result.resultId });
    if (result.critical) {
      this.#openClosure(order, result);
    }
    return result;
  }

  ingestDeviceResult(input: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly resultId: string;
    readonly value: string;
    readonly critical: boolean;
    readonly recordedAt: string;
    readonly calibration: DeviceCalibration | null;
    readonly synthetic: true;
  }): LabResult {
    requireSynthetic(input.synthetic);
    const order = this.#requireOrder(input.tenantId, input.orderId);
    this.#requireNoResults(order);
    const calibration = this.#requireCalibration(input.calibration);
    const result = this.#putResult({
      tenantId: order.tenantId,
      order,
      resultId: input.resultId,
      value: input.value,
      critical: input.critical,
      recordedAt: input.recordedAt,
      source: 'device',
      provisional: false,
      reconciliation: 'not-applicable',
      supersedesResultId: null,
      readBack: null,
      calibration,
    });
    this.#replaceOrder(order, { status: 'resulted', currentResultId: result.resultId });
    if (result.critical) {
      this.#openClosure(order, result);
    }
    return result;
  }

  correctResult(input: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly priorResultId: string;
    readonly resultId: string;
    readonly value: string;
    readonly critical: boolean;
    readonly recordedAt: string;
    readonly synthetic: true;
  }): LabResult {
    requireSynthetic(input.synthetic);
    const order = this.#requireOrder(input.tenantId, input.orderId);
    const prior = this.readResult(input.tenantId, input.priorResultId);
    if (prior.orderId !== order.orderId || order.currentResultId !== prior.resultId) {
      throw new LabError('LAB_NOT_CURRENT', `result ${prior.resultId} is not the current result`);
    }
    if (prior.source !== 'electronic') {
      throw new LabError(
        'LAB_ORDER_STATE',
        'manual results are reconciled, not corrected in place',
      );
    }
    const result = this.#putResult({
      tenantId: order.tenantId,
      order,
      resultId: input.resultId,
      value: input.value,
      critical: input.critical,
      recordedAt: input.recordedAt,
      source: 'electronic',
      provisional: false,
      reconciliation: 'not-applicable',
      supersedesResultId: prior.resultId,
      readBack: null,
      calibration: null,
    });
    this.#replaceOrder(order, { status: 'resulted', currentResultId: result.resultId });
    if (result.critical && !this.#closures.has(key(order.tenantId, result.resultId))) {
      this.#openClosure(order, result);
    }
    return result;
  }

  readResult(tenantId: string, resultId: string): LabResult {
    const result = this.#results.get(
      key(requireId(tenantId, 'tenantId'), requireId(resultId, 'resultId')),
    );
    if (result === undefined) {
      throw new LabError('LAB_NOT_FOUND', `result ${resultId} was not found`);
    }
    return result;
  }

  currentResult(tenantId: string, orderId: string): LabResult | null {
    const order = this.#requireOrder(tenantId, orderId);
    if (order.currentResultId === null) return null;
    return this.readResult(tenantId, order.currentResultId);
  }

  history(tenantId: string, orderId: string): readonly LabResult[] {
    const order = this.#requireOrder(tenantId, orderId);
    return [...this.#results.values()]
      .filter((result) => result.tenantId === order.tenantId && result.orderId === order.orderId)
      .sort(
        (left, right) =>
          left.recordedAt.localeCompare(right.recordedAt) ||
          left.resultId.localeCompare(right.resultId),
      );
  }

  closureFor(tenantId: string, resultId: string): CriticalClosure {
    const closure = this.#closures.get(
      key(requireId(tenantId, 'tenantId'), requireId(resultId, 'resultId')),
    );
    if (closure === undefined) {
      throw new LabError('LAB_NOT_FOUND', `critical closure for ${resultId} was not found`);
    }
    return closure;
  }

  acknowledgeCritical(input: {
    readonly tenantId: string;
    readonly resultId: string;
    readonly actorRef: string;
    readonly at: string;
    readonly synthetic: true;
  }): CriticalClosure {
    requireSynthetic(input.synthetic);
    const closure = this.closureFor(input.tenantId, input.resultId);
    if (closure.phase !== 'paged') {
      throw new LabError('LAB_CLOSURE_STEP', `acknowledge requires paged, found ${closure.phase}`);
    }
    const at = requireInstant(input.at, 'at');
    const actorRef = requireId(input.actorRef, 'actorRef');
    const workItem = withEvent(closure.workItem, {
      workItemId: closure.workItem.workItemId,
      eventSeq: closure.workItem.lastEventSeq + 1,
      eventType: 'assigned',
      occurredAt: at,
      toOwnerRef: actorRef,
      reason: 'assignment',
    });
    return this.#saveClosure({
      ...closure,
      phase: 'acknowledged',
      acknowledgedAt: at,
      acknowledgedBy: actorRef,
      workItem,
    });
  }

  recordCriticalContact(input: {
    readonly tenantId: string;
    readonly resultId: string;
    readonly at: string;
    readonly evidence: string;
    readonly synthetic: true;
  }): CriticalClosure {
    requireSynthetic(input.synthetic);
    const closure = this.closureFor(input.tenantId, input.resultId);
    if (closure.phase !== 'acknowledged') {
      throw new LabError(
        'LAB_CLOSURE_STEP',
        `contact requires acknowledged, found ${closure.phase}`,
      );
    }
    return this.#saveClosure({
      ...closure,
      phase: 'contacted',
      contactedAt: requireInstant(input.at, 'at'),
      contactEvidence: requireText(input.evidence, 'evidence'),
    });
  }

  closeCritical(input: {
    readonly tenantId: string;
    readonly resultId: string;
    readonly actorRef: string;
    readonly at: string;
    readonly synthetic: true;
  }): CriticalClosure {
    requireSynthetic(input.synthetic);
    const closure = this.closureFor(input.tenantId, input.resultId);
    if (closure.phase !== 'contacted') {
      throw new LabError('LAB_CLOSURE_STEP', `close requires contacted, found ${closure.phase}`);
    }
    const at = requireInstant(input.at, 'at');
    const actorRef = requireId(input.actorRef, 'actorRef');
    const workItem = withEvent(closure.workItem, {
      workItemId: closure.workItem.workItemId,
      eventSeq: closure.workItem.lastEventSeq + 1,
      eventType: 'resolved',
      occurredAt: at,
      actorRef,
    });
    return this.#saveClosure({
      ...closure,
      phase: 'closed',
      closedAt: at,
      closedBy: actorRef,
      workItem,
    });
  }

  widenRecallCohort(input: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly lotId: string;
    readonly recalledAt: string;
    readonly synthetic: true;
  }): RecallCohort {
    requireSynthetic(input.synthetic);
    const tenantId = requireId(input.tenantId, 'tenantId');
    const deviceId = requireId(input.deviceId, 'deviceId');
    const lotId = requireId(input.lotId, 'lotId');
    const recalledAt = requireInstant(input.recalledAt, 'recalledAt');
    const resultIds = [...this.#results.values()]
      .filter(
        (result) =>
          result.tenantId === tenantId &&
          result.source === 'device' &&
          result.calibration?.deviceId === deviceId &&
          result.calibration.lotId === lotId,
      )
      .map((result) => result.resultId)
      .sort();
    const cohort: RecallCohort = {
      tenantId,
      recallId: requireId(`recall-${deviceId}-${lotId}`, 'recallId'),
      deviceId,
      lotId,
      recalledAt,
      resultIds,
      synthetic: true,
    };
    this.#recalls.set(key(tenantId, `${deviceId}\u0000${lotId}`), cohort);
    return cohort;
  }

  ageExpectedResults(now: string): readonly ExpectedResultAge[] {
    const at = requireInstant(now, 'now');
    const due = [...this.#orders.values()].filter((order) => {
      if (order.status !== 'awaiting-result') return false;
      if (this.history(order.tenantId, order.orderId).length > 0) return false;
      return instantMs(order.expectedResultBy) <= instantMs(at);
    });
    for (const order of due) {
      const ageKey = key(order.tenantId, order.orderId);
      if (this.#ages.has(ageKey)) continue;
      const aged: ExpectedResultAge = {
        tenantId: order.tenantId,
        orderId: order.orderId,
        agedAt: at,
        workItem: openWorkItem({
          workItemId: requireId(`wi-age-${order.orderId}`, 'workItemId'),
          subjectRef: order.orderId,
          purpose: 'lab.expected-result-aging',
          risk: 'elevated',
          poolId: 'lab-expected-results',
          openedAt: at,
          responseDueAt: order.expectedResultBy,
        }),
        synthetic: true,
      };
      this.#ages.set(ageKey, aged);
    }
    return due.map((order) => {
      const aged = this.#ages.get(key(order.tenantId, order.orderId));
      if (aged === undefined) {
        throw new LabError('LAB_NOT_FOUND', `aging row for ${order.orderId} was not found`);
      }
      return aged;
    });
  }

  enterOutageManual(input: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly resultId: string;
    readonly value: string;
    readonly critical: boolean;
    readonly enteredAt: string;
    readonly readBack: ReadBack;
    readonly synthetic: true;
  }): LabResult {
    requireSynthetic(input.synthetic);
    const order = this.#requireOrder(input.tenantId, input.orderId);
    if (order.status !== 'awaiting-result') {
      throw new LabError(
        'LAB_ORDER_STATE',
        'outage entry requires an order still awaiting a result',
      );
    }
    this.#requireNoResults(order);
    const readBack = this.#requireReadBack(input.readBack, input.value);
    const result = this.#putResult({
      tenantId: order.tenantId,
      order,
      resultId: input.resultId,
      value: readBack.confirmedValue,
      critical: input.critical,
      recordedAt: input.enteredAt,
      source: 'manual',
      provisional: true,
      reconciliation: 'pending',
      supersedesResultId: null,
      readBack,
      calibration: null,
    });
    this.#replaceOrder(order, { currentResultId: result.resultId });
    if (result.critical) {
      this.#openClosure(order, result);
    }
    return result;
  }

  reconcileElectronic(input: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly manualResultId: string;
    readonly resultId: string;
    readonly value: string;
    readonly critical: boolean;
    readonly recordedAt: string;
    readonly synthetic: true;
  }): Reconciliation {
    requireSynthetic(input.synthetic);
    const order = this.#requireOrder(input.tenantId, input.orderId);
    const manual = this.readResult(input.tenantId, input.manualResultId);
    if (
      manual.orderId !== order.orderId ||
      manual.source !== 'manual' ||
      manual.reconciliation !== 'pending'
    ) {
      throw new LabError(
        'LAB_ORDER_STATE',
        'reconciliation requires the pending provisional manual result',
      );
    }
    if (order.currentResultId !== manual.resultId) {
      throw new LabError('LAB_NOT_CURRENT', 'the provisional manual result is no longer current');
    }
    const sameValue = requireText(input.value, 'value') === manual.value;
    const electronic = this.#putResult({
      tenantId: order.tenantId,
      order,
      resultId: input.resultId,
      value: input.value,
      critical: input.critical,
      recordedAt: input.recordedAt,
      source: 'electronic',
      provisional: !sameValue,
      reconciliation: sameValue ? 'matched' : 'conflict',
      supersedesResultId: null,
      readBack: null,
      calibration: null,
    });
    const updatedManual: LabResult = {
      ...manual,
      reconciliation: sameValue ? 'matched' : 'conflict',
    };
    this.#results.set(key(order.tenantId, manual.resultId), updatedManual);
    if (sameValue) {
      this.#replaceOrder(order, { status: 'resulted', currentResultId: electronic.resultId });
    }
    const reconciliation: Reconciliation = {
      tenantId: order.tenantId,
      orderId: order.orderId,
      manualResultId: manual.resultId,
      electronicResultId: electronic.resultId,
      state: sameValue ? 'matched' : 'conflict',
      decision: null,
      decidedBy: null,
      decidedAt: null,
      synthetic: true,
    };
    this.#reconciliations.set(key(order.tenantId, order.orderId), reconciliation);
    return reconciliation;
  }

  adjudicateConflict(input: {
    readonly tenantId: string;
    readonly orderId: string;
    readonly decision: 'keep-manual' | 'accept-electronic';
    readonly actorRef: string;
    readonly at: string;
    readonly synthetic: true;
  }): Reconciliation {
    requireSynthetic(input.synthetic);
    const order = this.#requireOrder(input.tenantId, input.orderId);
    const current = this.#reconciliations.get(key(order.tenantId, order.orderId));
    if (current === undefined || current.state !== 'conflict') {
      throw new LabError('LAB_NO_CONFLICT', 'adjudication requires an open value conflict');
    }
    const at = requireInstant(input.at, 'at');
    const actorRef = requireId(input.actorRef, 'actorRef');
    const manual = this.readResult(order.tenantId, current.manualResultId);
    const electronic = this.readResult(order.tenantId, current.electronicResultId);
    const manualState: ReconciliationState =
      input.decision === 'keep-manual' ? 'adjudicated-manual' : 'adjudicated-electronic';
    const electronicState: ReconciliationState = manualState;
    this.#results.set(key(order.tenantId, manual.resultId), {
      ...manual,
      reconciliation: manualState,
      provisional: true,
    });
    this.#results.set(key(order.tenantId, electronic.resultId), {
      ...electronic,
      reconciliation: electronicState,
      provisional: false,
    });
    if (input.decision === 'accept-electronic') {
      this.#replaceOrder(order, { status: 'resulted', currentResultId: electronic.resultId });
    }
    const decided: Reconciliation = {
      ...current,
      state: 'adjudicated',
      decision: input.decision,
      decidedBy: actorRef,
      decidedAt: at,
    };
    this.#reconciliations.set(key(order.tenantId, order.orderId), decided);
    return decided;
  }

  reconciliationFor(tenantId: string, orderId: string): Reconciliation {
    const order = this.#requireOrder(tenantId, orderId);
    const found = this.#reconciliations.get(key(order.tenantId, order.orderId));
    if (found === undefined) {
      throw new LabError('LAB_NOT_FOUND', `reconciliation for ${order.orderId} was not found`);
    }
    return found;
  }

  #requireOrder(tenantId: string, orderId: string): LabOrder {
    const order = this.#orders.get(
      key(requireId(tenantId, 'tenantId'), requireId(orderId, 'orderId')),
    );
    if (order === undefined) {
      throw new LabError('LAB_NOT_FOUND', `order ${orderId} was not found`);
    }
    return order;
  }

  #requireNoResults(order: LabOrder): void {
    if (this.history(order.tenantId, order.orderId).length > 0) {
      throw new LabError('LAB_ORDER_STATE', `order ${order.orderId} already has a result`);
    }
  }

  #requireCalibration(calibration: DeviceCalibration | null): DeviceCalibration {
    if (calibration === null) {
      throw new LabError('LAB_CALIBRATION', 'a device result requires calibration metadata');
    }
    const deviceId = requireId(calibration.deviceId, 'deviceId');
    const lotId = requireId(calibration.lotId, 'lotId');
    return {
      deviceId,
      lotId,
      calibratedAt: requireInstant(calibration.calibratedAt, 'calibratedAt'),
      method: requireText(calibration.method, 'method'),
    };
  }

  #requireReadBack(readBack: ReadBack, value: string): ReadBack {
    const confirmedValue = requireText(readBack.confirmedValue, 'confirmedValue');
    const entered = requireText(value, 'value');
    if (confirmedValue !== entered) {
      throw new LabError('LAB_READ_BACK', 'read-back value does not match the entered value');
    }
    return {
      readBackBy: requireId(readBack.readBackBy, 'readBackBy'),
      readBackAt: requireInstant(readBack.readBackAt, 'readBackAt'),
      confirmedValue,
    };
  }

  #putResult(input: {
    readonly tenantId: string;
    readonly order: LabOrder;
    readonly resultId: string;
    readonly value: string;
    readonly critical: boolean;
    readonly recordedAt: string;
    readonly source: LabResult['source'];
    readonly provisional: boolean;
    readonly reconciliation: ReconciliationState;
    readonly supersedesResultId: string | null;
    readonly readBack: ReadBack | null;
    readonly calibration: DeviceCalibration | null;
  }): LabResult {
    const resultId = requireId(input.resultId, 'resultId');
    const resultKey = key(input.tenantId, resultId);
    if (this.#results.has(resultKey)) {
      throw new LabError('LAB_DUPLICATE', `result ${resultId} already exists`);
    }
    if (input.source === 'manual' && (input.provisional !== true || input.readBack === null)) {
      throw new LabError(
        'LAB_PROVISIONAL',
        'a manual result is provisional and carries a read-back',
      );
    }
    if (input.source === 'device') {
      if (input.calibration === null) {
        throw new LabError('LAB_CALIBRATION', 'a device result requires calibration metadata');
      }
    } else if (input.calibration !== null) {
      throw new LabError('LAB_CALIBRATION', 'calibration metadata belongs on a device result');
    }
    const recordedAt = requireInstant(input.recordedAt, 'recordedAt');
    const value = requireText(input.value, 'value');
    const result: LabResult = {
      resultId,
      tenantId: input.order.tenantId,
      orderId: input.order.orderId,
      supersedesResultId: input.supersedesResultId,
      value,
      critical: input.critical,
      recordedAt,
      source: input.source,
      provisional: input.provisional,
      reconciliation: input.reconciliation,
      readBack: input.readBack,
      calibration: input.calibration,
      observation: resource({
        resourceType: 'Observation',
        id: resultId,
        tenantId: input.order.tenantId,
        subjectRef: input.order.subjectRef,
        code: input.order.code,
        display: input.order.display,
      }),
      report: resource({
        resourceType: 'DiagnosticReport',
        id: requireId(`report-${resultId}`, 'reportId'),
        tenantId: input.order.tenantId,
        subjectRef: input.order.subjectRef,
        code: input.order.code,
        display: input.order.display,
      }),
      synthetic: true,
    };
    this.#results.set(resultKey, result);
    return result;
  }

  #replaceOrder(
    order: LabOrder,
    patch: Pick<LabOrder, 'status' | 'currentResultId'> | Pick<LabOrder, 'currentResultId'>,
  ): void {
    const next: LabOrder = { ...order, ...patch };
    this.#orders.set(key(order.tenantId, order.orderId), next);
  }

  #openClosure(order: LabOrder, result: LabResult): CriticalClosure {
    const closure: CriticalClosure = {
      closureId: requireId(`closure-${result.resultId}`, 'closureId'),
      tenantId: order.tenantId,
      orderId: order.orderId,
      resultId: result.resultId,
      phase: 'paged',
      pagedAt: result.recordedAt,
      acknowledgedAt: null,
      acknowledgedBy: null,
      contactedAt: null,
      contactEvidence: null,
      closedAt: null,
      closedBy: null,
      workItem: openWorkItem({
        workItemId: requireId(`wi-crit-${result.resultId}`, 'workItemId'),
        subjectRef: order.orderId,
        purpose: 'lab.critical-closure',
        risk: 'critical',
        poolId: 'lab-critical-results',
        openedAt: result.recordedAt,
        responseDueAt: result.recordedAt,
      }),
      synthetic: true,
    };
    this.#closures.set(key(order.tenantId, result.resultId), closure);
    return closure;
  }

  #saveClosure(closure: CriticalClosure): CriticalClosure {
    this.#closures.set(key(closure.tenantId, closure.resultId), closure);
    return closure;
  }
}
