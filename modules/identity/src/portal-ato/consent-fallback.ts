/**
 * E-sign outage consent fallback at check-in (WP-099; REQ-PORT-020, REQ-PORT-018 EX1). A visit
 * never proceeds without its blocking consents; an outage switches the remaining forms to a paper
 * kit of current approved versions; a stale form is refused at capture; a recovered rail resumes
 * electronic signing without re-demanding anything already captured on paper.
 */

import type {
  ConsentEsignRail,
  ConsentFormCatalogPort,
  ConsentSignatureEvidence,
  VisitConsentMatrixPort,
} from './ports.js';
import {
  ConsentFallbackError,
  type CheckIn,
  type CheckInConsentState,
  type FormCaptureState,
  type PaperFallbackKit,
  type PendingPaperConsent,
  type PlannedConsentForm,
  type VisitDecision,
} from './types.js';

/** Which consents this visit needs and how each can be signed right now. */
export function planCheckInConsents(
  checkIn: CheckIn,
  matrix: VisitConsentMatrixPort,
  catalog: ConsentFormCatalogPort,
): readonly PlannedConsentForm[] {
  if (checkIn.synthetic !== true) throw new ConsentFallbackError('check-in must be synthetic');
  return matrix.rulesFor(checkIn.jurisdiction, checkIn.visitType).map((rule) => {
    const current = catalog.currentVersion(rule.formId);
    if (current === null) {
      return {
        formId: rule.formId,
        blocking: rule.blocking,
        version: null,
        path: 'version-unavailable',
      };
    }
    const readable = current.vettedLanguages.includes(checkIn.preferredLanguage);
    return {
      formId: rule.formId,
      blocking: rule.blocking,
      version: current.version,
      path: readable ? 'electronic' : 'interpreter-assisted',
    };
  });
}

function signedEvidenceRef(evidence: ConsentSignatureEvidence): string | null {
  return evidence.status === 'signed' && evidence.evidenceRef ? evidence.evidenceRef : null;
}

function withCapture(
  state: CheckInConsentState,
  formId: string,
  capture: FormCaptureState,
): CheckInConsentState {
  return { ...state, captures: { ...state.captures, [formId]: capture } };
}

function requestElectronic(
  state: CheckInConsentState,
  rail: ConsentEsignRail,
  catalog: ConsentFormCatalogPort,
  form: PlannedConsentForm,
): { readonly state: CheckInConsentState; readonly outage: boolean } {
  const current = catalog.currentVersion(form.formId);
  if (current === null) return { state, outage: false };
  let evidence: ConsentSignatureEvidence;
  try {
    evidence = rail.request({
      requestId: `${state.checkIn.checkInId}:${form.formId}:${current.version}`,
      tenantId: state.checkIn.tenantId,
      documentId: current.documentId,
      versionNo: current.versionNo,
      contentHash: current.contentHash,
      signerRefs: [state.checkIn.patientRef],
      method: 'click-to-sign',
      synthetic: true,
    });
  } catch {
    return { state, outage: true };
  }
  const evidenceRef = signedEvidenceRef(evidence);
  if (evidenceRef !== null) {
    return {
      state: withCapture(state, form.formId, {
        kind: 'signed-electronic',
        evidenceRef,
        version: current.version,
      }),
      outage: false,
    };
  }
  if (evidence.status === 'declined') {
    return {
      state: withCapture(state, form.formId, { kind: 'refused', recordedBy: 'esign-rail' }),
      outage: false,
    };
  }
  return { state, outage: false };
}

/**
 * Start consent for one check-in. Forms are sent to the e-sign rail in order; the first failed
 * request is an outage: the rail is not called again, and every form still unsigned moves to a
 * paper kit of current approved versions with a blocking checklist (REQ-PORT-020 AC1/AC4).
 */
export function startCheckInConsent(
  checkIn: CheckIn,
  deps: {
    readonly matrix: VisitConsentMatrixPort;
    readonly catalog: ConsentFormCatalogPort;
    readonly rail: ConsentEsignRail;
  },
  ids: { readonly kitId: string; readonly outageId: string },
): CheckInConsentState {
  const forms = planCheckInConsents(checkIn, deps.matrix, deps.catalog);
  let state: CheckInConsentState = {
    checkIn,
    outageId: null,
    forms,
    captures: Object.fromEntries(
      forms.map((form): [string, FormCaptureState] => [form.formId, { kind: 'pending' }]),
    ),
    kit: null,
  };
  for (const form of forms) {
    if (form.path !== 'electronic') continue;
    const step = requestElectronic(state, deps.rail, deps.catalog, form);
    state = step.state;
    if (step.outage) {
      state = { ...state, outageId: ids.outageId };
      break;
    }
  }
  if (state.outageId === null) return state;
  const toPaper = forms.map((form) =>
    form.path === 'electronic' && state.captures[form.formId]?.kind === 'pending'
      ? { ...form, path: 'paper' as const }
      : form,
  );
  const kitForms = toPaper.filter((form) => form.path === 'paper' && form.version !== null);
  const kit: PaperFallbackKit = {
    kitId: ids.kitId,
    checkInId: checkIn.checkInId,
    outageId: ids.outageId,
    forms: kitForms.map((form) => ({ formId: form.formId, version: form.version ?? '' })),
    checklist: kitForms.map((form) => ({ formId: form.formId, blocking: form.blocking })),
  };
  return { ...state, forms: toPaper, kit };
}

/**
 * Audit a pre-printed kit inventory against the current approved versions (REQ-PORT-020 AC4/EX2):
 * every form whose printed version is not current is returned and must not be used.
 */
export function auditPaperKit(
  printed: readonly { readonly formId: string; readonly version: string }[],
  catalog: ConsentFormCatalogPort,
): readonly {
  readonly formId: string;
  readonly printed: string;
  readonly current: string | null;
}[] {
  return printed
    .map((form) => ({
      formId: form.formId,
      printed: form.version,
      current: catalog.currentVersion(form.formId)?.version ?? null,
    }))
    .filter((form) => form.current !== form.printed);
}

/**
 * Record one paper signature during an outage. A form on a stale version is blocked, never
 * collected (REQ-PORT-020 EX2); a form already captured is not demanded again (EX3).
 */
export function recordPaperCapture(
  state: CheckInConsentState,
  capture: {
    readonly formId: string;
    readonly presentedVersion: string;
    readonly outcome: 'signed' | 'refused';
    readonly captureId: string;
    readonly capturedBy: string;
    readonly capturedAt: string;
  },
  catalog: ConsentFormCatalogPort,
): CheckInConsentState {
  const form = state.forms.find((item) => item.formId === capture.formId);
  if (form === undefined) {
    throw new ConsentFallbackError(`form ${capture.formId} is not required for this visit`);
  }
  if (form.path !== 'paper' && form.path !== 'interpreter-assisted') {
    throw new ConsentFallbackError(`form ${capture.formId} is not on the paper path`);
  }
  if (!capture.capturedBy) throw new ConsentFallbackError('a paper capture names who collected it');
  const existing = state.captures[capture.formId];
  if (existing?.kind === 'captured-paper' || existing?.kind === 'signed-electronic') {
    throw new ConsentFallbackError(`form ${capture.formId} is already captured; not re-demanded`);
  }
  const current = catalog.currentVersion(capture.formId);
  if (current === null || capture.presentedVersion !== current.version) {
    return withCapture(state, capture.formId, {
      kind: 'stale-version-blocked',
      presentedVersion: capture.presentedVersion,
    });
  }
  if (capture.outcome === 'refused') {
    return withCapture(state, capture.formId, { kind: 'refused', recordedBy: capture.capturedBy });
  }
  return withCapture(state, capture.formId, {
    kind: 'captured-paper',
    captureId: capture.captureId,
    version: current.version,
    capturedBy: capture.capturedBy,
    capturedAt: capture.capturedAt,
  });
}

function satisfied(capture: FormCaptureState | undefined): boolean {
  return capture?.kind === 'captured-paper' || capture?.kind === 'signed-electronic';
}

/**
 * Hold or proceed (REQ-PORT-020 AC2/AC3/EX1). Any blocking consent not validly signed holds the
 * visit; otherwise it proceeds with paper captures visible as pending digitization and unsigned
 * non-blocking forms deferred.
 */
export function decideVisit(state: CheckInConsentState): VisitDecision {
  const missing = state.forms.filter(
    (form) => form.blocking && !satisfied(state.captures[form.formId]),
  );
  if (missing.length > 0) {
    return {
      decision: 'hold',
      missingBlocking: missing.map((form) => form.formId),
      reasons: missing.map((form) => {
        const capture = state.captures[form.formId];
        const kind = capture?.kind ?? 'pending';
        return `${form.formId}:${kind === 'pending' ? form.path : kind}`;
      }),
    };
  }
  return {
    decision: 'proceed',
    capturedOnPaperPendingDigitization: state.forms
      .filter((form) => state.captures[form.formId]?.kind === 'captured-paper')
      .map((form) => form.formId),
    deferredNonBlocking: state.forms
      .filter((form) => !form.blocking && !satisfied(state.captures[form.formId]))
      .map((form) => form.formId),
  };
}

/**
 * The rail recovered mid-visit (REQ-PORT-020 EX3): forms still unsigned go electronic; anything
 * captured on paper stays as it is and is reconciled through digitization, never duplicated.
 * If the rail is still down the state is returned unchanged.
 */
export function resumeAfterRecovery(
  state: CheckInConsentState,
  rail: ConsentEsignRail,
  catalog: ConsentFormCatalogPort,
): CheckInConsentState {
  let next = state;
  for (const form of state.forms) {
    if (form.path !== 'paper') continue;
    const kind = next.captures[form.formId]?.kind;
    if (kind !== 'pending' && kind !== 'stale-version-blocked') continue;
    const step = requestElectronic(next, rail, catalog, { ...form, path: 'electronic' });
    if (step.outage) return state;
    next = step.state;
  }
  return next;
}

/** Paper captures awaiting digitization for this check-in (REQ-PLAT-033 AC4 input). */
export function pendingDigitizations(state: CheckInConsentState): readonly PendingPaperConsent[] {
  const outageId = state.outageId;
  if (outageId === null) return [];
  const pending: PendingPaperConsent[] = [];
  for (const form of state.forms) {
    const capture = state.captures[form.formId];
    if (capture?.kind !== 'captured-paper') continue;
    pending.push({
      captureId: capture.captureId,
      checkInId: state.checkIn.checkInId,
      outageId,
      patientRef: state.checkIn.patientRef,
      encounterRef: state.checkIn.encounterRef,
      formId: form.formId,
      version: capture.version,
      capturedAt: capture.capturedAt,
      capturedBy: capture.capturedBy,
    });
  }
  return pending;
}
