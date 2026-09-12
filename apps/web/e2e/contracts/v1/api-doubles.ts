import { createHash } from 'node:crypto';

import type { BrowserContext, Page, Route } from '@playwright/test';

import type { ContractFixture, JourneyContract } from './types.js';

export const apiOrigin = 'https://wp035.invalid';

interface LedgerEntry {
  readonly fingerprint: string;
  readonly response: Readonly<Record<string, unknown>>;
}

const ledgers = new WeakMap<BrowserContext, Map<string, LedgerEntry>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function failureMessage(fixture: ContractFixture): string {
  const english: Readonly<Record<ContractFixture['failureMode'], string>> = {
    none: 'Synthetic dependency unavailable.',
    validation: 'The submitted action is invalid.',
    authority: 'Current staff authority does not permit owner acceptance.',
    consent: 'Required paid-service consent is absent.',
    translation: 'A certified translation is unavailable; use interpreter-assisted completion.',
    accommodation: 'The requested accommodation is unavailable; use the human-assisted path.',
    dependency: 'Outcome is temporarily unknown; retry safely.',
  };
  const spanish: Readonly<Record<ContractFixture['failureMode'], string>> = {
    none: 'La dependencia sintética no está disponible.',
    validation: 'La acción enviada no es válida.',
    authority: 'La autoridad actual no permite aceptar al responsable.',
    consent: 'Falta el consentimiento requerido para el servicio pagado.',
    translation: 'No hay traducción certificada; use la finalización asistida por intérprete.',
    accommodation:
      'La adaptación solicitada no está disponible; use la alternativa con asistencia humana.',
    dependency: 'El resultado es temporalmente desconocido; reintente de forma segura.',
  };
  return (fixture.locale === 'es' ? spanish : english)[fixture.failureMode];
}

async function reject(route: Route, status: number, message: string): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ synthetic: true, error: message, effectCount: 0 }),
  });
}

export async function registerClosedApi(
  page: Page,
  contract: JourneyContract,
  fixture: ContractFixture,
): Promise<void> {
  const context = page.context();
  const ledger = ledgers.get(context) ?? new Map<string, LedgerEntry>();
  ledgers.set(context, ledger);

  // Context routing covers this page and pop-ups. serviceWorkers:'block' in the
  // Playwright config prevents a worker from bypassing this default-deny fence.
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.url() !== contract.endpoint || request.method() !== 'POST') {
      await route.abort('blockedbyclient');
      return;
    }
    if (!((await request.headerValue('content-type')) ?? '').startsWith('application/json')) {
      await reject(route, 415, 'content-type must be application/json');
      return;
    }
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      await reject(route, 400, 'request body must be valid JSON');
      return;
    }
    if (
      !isRecord(body) ||
      !hasExactKeys(body, ['contractId', 'operationKey', 'reference', 'action']) ||
      body['contractId'] !== contract.id ||
      body['operationKey'] !== fixture.operationKey ||
      !isRecord(body['reference']) ||
      !hasExactKeys(body['reference'], ['subjectId', 'personaSlug', 'journey']) ||
      body['reference']['subjectId'] !== fixture.reference.subjectId ||
      body['reference']['personaSlug'] !== fixture.reference.personaSlug ||
      body['reference']['journey'] !== fixture.reference.journey ||
      !isRecord(body['action']) ||
      typeof body['action']['note'] !== 'string' ||
      body['action']['note'].trim().length === 0 ||
      body['action']['note'].length > 500
    ) {
      await reject(route, 400, 'request identity/reference/schema mismatch');
      return;
    }
    const expectedAction = contract.createAction(body['action']['note']);
    if (
      !hasExactKeys(body['action'], Object.keys(expectedAction)) ||
      JSON.stringify(body['action']) !== JSON.stringify(expectedAction)
    ) {
      await reject(route, 400, 'request action does not match the versioned domain contract');
      return;
    }
    const payloadFingerprint = fingerprint({
      contractId: body['contractId'],
      reference: body['reference'],
      action: body['action'],
    });
    const previous = ledger.get(fixture.operationKey);
    if (previous) {
      if (previous.fingerprint !== payloadFingerprint) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            synthetic: true,
            contractId: contract.id,
            effectCount: 1,
            conflict: true,
            message: 'Operation key was already used with a different payload.',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...previous.response, replay: true }),
      });
      return;
    }
    if (fixture.apiOutcome === 'failure') {
      await route.fulfill({
        status: fixture.failureMode === 'validation' ? 422 : 403,
        contentType: 'application/json',
        body: JSON.stringify({
          synthetic: true,
          contractId: contract.id,
          effectCount: 0,
          failureMode: fixture.failureMode,
          message: failureMessage(fixture),
        }),
      });
      return;
    }
    const response = {
      synthetic: true,
      contractId: contract.id,
      subjectId: fixture.reference.subjectId,
      operationKey: fixture.operationKey,
      payloadFingerprint,
      simulatedClock: '2026-01-01T00:00:00Z',
      effectCount: 1,
      replay: false,
      message:
        fixture.locale === 'es'
          ? 'La acción sintética se completó exactamente una vez.'
          : 'Synthetic action completed exactly once.',
    } as const;
    ledger.set(fixture.operationKey, { fingerprint: payloadFingerprint, response });
    if (fixture.apiOutcome === 'recoverable') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          synthetic: true,
          contractId: contract.id,
          effectCount: 1,
          landed: true,
          message: failureMessage(fixture),
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}
