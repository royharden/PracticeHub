/**
 * Ports for the e-sign outage consent fallback. The identity module has no dependency on the
 * documents, consent or encounters modules, and this package adds none, so each collaborator is a
 * port here with a named in-memory PLACEHOLDER. A later pass binds them and retests:
 *  - `ConsentEsignRail`: the `request` half of documents `EsignPort` (WP-025), same shapes.
 *  - `ConsentFormCatalogPort`: current approved consent-form versions (WP-025 document versions).
 *  - `VisitConsentMatrixPort`: which consents a jurisdiction and visit type require, and which
 *    of them block the visit (consent policy registry, WP-018).
 *  - `PaperConsentLedgerPort`: the consent ledger (WP-018; intake consent capture WP-042).
 */

import {
  ConsentFallbackError,
  type ConsentFormVersion,
  type ConsentJurisdiction,
  type PaperConsentLedgerEntry,
  type VisitConsentRule,
} from './types.js';

export type ConsentSignatureMethod =
  'click-to-sign' | 'drawn-signature' | 'typed-signature' | 'knowledge-based';

/** Same fields as documents `SignatureRequest` (WP-025). */
export interface ConsentSignatureRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly contentHash: string;
  readonly signerRefs: readonly string[];
  readonly method: ConsentSignatureMethod;
  readonly synthetic: true;
}

/** Same fields as documents `SignatureEvidence` (WP-025). */
export interface ConsentSignatureEvidence {
  readonly requestId: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly status: 'signed' | 'pending' | 'declined';
  readonly signerRefs: readonly string[];
  readonly method: ConsentSignatureMethod;
  readonly certificateHash?: string;
  readonly signedAt?: string;
  readonly evidenceRef?: string;
  readonly synthetic: true;
}

/** The `request` half of documents `EsignPort`. A thrown request is how an outage shows. */
export interface ConsentEsignRail {
  request(input: ConsentSignatureRequest): ConsentSignatureEvidence;
}

export interface ConsentFormCatalogPort {
  currentVersion(formId: string): ConsentFormVersion | null;
}

export interface VisitConsentMatrixPort {
  rulesFor(jurisdiction: ConsentJurisdiction, visitType: string): readonly VisitConsentRule[];
}

export interface ElectronicConsentRecord {
  readonly patientRef: string;
  readonly formId: string;
  readonly version: string;
  readonly signedAt: string;
  readonly evidenceRef: string;
}

export interface PaperConsentLedgerPort {
  latestElectronicConsent(patientRef: string, formId: string): ElectronicConsentRecord | null;
  hasPaperConsent(captureId: string): boolean;
  appendPaperConsent(entry: PaperConsentLedgerEntry): void;
}

/** PLACEHOLDER for the WP-025 consent-form version store. */
export class InMemoryConsentFormCatalog implements ConsentFormCatalogPort {
  readonly #forms: ReadonlyMap<string, ConsentFormVersion>;

  public constructor(forms: readonly ConsentFormVersion[]) {
    this.#forms = new Map(forms.map((form) => [form.formId, form]));
  }

  public currentVersion(formId: string): ConsentFormVersion | null {
    return this.#forms.get(formId) ?? null;
  }
}

/** PLACEHOLDER for the WP-018 consent policy registry (state x visit-type matrix). */
export class InMemoryVisitConsentMatrix implements VisitConsentMatrixPort {
  readonly #rules: ReadonlyMap<string, readonly VisitConsentRule[]>;

  public constructor(
    entries: readonly {
      readonly jurisdiction: ConsentJurisdiction;
      readonly visitType: string;
      readonly rules: readonly VisitConsentRule[];
    }[],
  ) {
    this.#rules = new Map(
      entries.map((entry) => [`${entry.jurisdiction}|${entry.visitType}`, entry.rules]),
    );
  }

  public rulesFor(
    jurisdiction: ConsentJurisdiction,
    visitType: string,
  ): readonly VisitConsentRule[] {
    const rules = this.#rules.get(`${jurisdiction}|${visitType}`);
    if (rules === undefined) {
      throw new ConsentFallbackError(
        `no consent rules for ${jurisdiction}/${visitType}; the visit cannot be cleared`,
      );
    }
    return rules;
  }
}

/** PLACEHOLDER for the WP-018 consent ledger. Append-only; never overwrites. */
export class InMemoryPaperConsentLedger implements PaperConsentLedgerPort {
  readonly #electronic: ElectronicConsentRecord[];
  readonly #paper: PaperConsentLedgerEntry[] = [];

  public constructor(electronic: readonly ElectronicConsentRecord[] = []) {
    this.#electronic = [...electronic];
  }

  public latestElectronicConsent(
    patientRef: string,
    formId: string,
  ): ElectronicConsentRecord | null {
    const matches = this.#electronic
      .filter((record) => record.patientRef === patientRef && record.formId === formId)
      .sort((a, b) => Date.parse(b.signedAt) - Date.parse(a.signedAt));
    return matches[0] ?? null;
  }

  public hasPaperConsent(captureId: string): boolean {
    return this.#paper.some((entry) => entry.captureId === captureId);
  }

  public appendPaperConsent(entry: PaperConsentLedgerEntry): void {
    if (this.hasPaperConsent(entry.captureId)) {
      throw new ConsentFallbackError(`paper consent ${entry.captureId} is already on the ledger`);
    }
    this.#paper.push(Object.freeze({ ...entry }));
  }

  public paperEntries(): readonly PaperConsentLedgerEntry[] {
    return [...this.#paper];
  }
}
