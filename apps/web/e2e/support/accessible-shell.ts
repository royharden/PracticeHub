import type { Page } from '@playwright/test';

import type { ContractFixture, SemanticState } from '../contracts/v1/types.js';

export interface AccessibleShellSpec {
  readonly contractId: string;
  readonly title: string;
  readonly actionLabel: string;
  readonly endpoint: string;
  readonly action: Readonly<Record<string, unknown>>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function mountAccessibleShell(
  page: Page,
  spec: AccessibleShellSpec,
  fixture: ContractFixture,
): Promise<void> {
  const isBoundary = fixture.fixtureClass === 'BOUNDARY';
  const spanish = fixture.locale === 'es';
  const copy = spanish
    ? {
        skip: 'Saltar al contenido principal',
        brand: 'Entorno sintético de aceptación de PracticeHub',
        workflow: 'Flujo de trabajo',
        help: 'Ayuda de accesibilidad',
        intro:
          'Complete este flujo sintético. No se contacta a ningún proveedor ni sistema de producción.',
        notice:
          'El contenido y los controles están traducidos. Los documentos legales sin traducción certificada se derivan a asistencia humana con intérprete.',
        error: 'La acción no se completó.',
        review: 'Revise la nota de acción',
        label: 'Nota de acción',
        hint: 'Obligatorio. Describa la próxima acción autorizada.',
        submitting: 'Enviando acción sintética.',
        validation: 'Corrija la nota de acción obligatoria.',
        incomplete:
          'La acción no se completó. Reintente o solicite la alternativa accesible con asistencia humana.',
        retry: 'Reintentar',
        footer: 'sintético',
        helpTitle: 'Ayuda de accesibilidad',
        helpText:
          'Use Tab para desplazarse, Intro o Espacio para activar y Escape para cerrar este diálogo.',
        close: 'Cerrar ayuda',
      }
    : {
        skip: 'Skip to main content',
        brand: 'PracticeHub synthetic acceptance shell',
        workflow: 'Workflow',
        help: 'Accessibility help',
        intro: 'Complete this synthetic workflow. No provider or production system is contacted.',
        notice: '',
        error: 'Action not completed.',
        review: 'Review the action note',
        label: 'Action note',
        hint: 'Required. Describe the authorized next action.',
        submitting: 'Submitting synthetic action.',
        validation: 'Correct the required action note.',
        incomplete:
          'The action was not completed. Use Retry or request the accessible human-assisted path.',
        retry: 'Retry',
        footer: 'synthetic',
        helpTitle: 'Accessibility help',
        helpText: 'Use Tab to move, Enter or Space to activate, and Escape to close this dialog.',
        close: 'Close help',
      };
  const intro = isBoundary
    ? 'Este contenido traducido deliberadamente largo demuestra que las instrucciones esenciales permanecen completas, visibles y operables cuando el texto crece, la ventana se estrecha y se solicita letra grande.'
    : copy.intro;
  const fallback = spanish
    ? '<p id="translation-notice" role="note">' + escapeHtml(copy.notice) + '</p>'
    : '';
  const bodyClass = fixture.largePrint ? 'large-print' : '';
  const html = [
    '<!doctype html><html lang="',
    escapeHtml(fixture.locale),
    '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>',
    escapeHtml(spec.title),
    '</title><style>',
    '*{box-sizing:border-box}body{font-family:system-ui,sans-serif;line-height:1.5;margin:0;color:#14213d;background:#fff}',
    '.skip{position:absolute;left:.5rem;top:-5rem;background:#fff;padding:.75rem;z-index:10}.skip:focus{top:.5rem}',
    'header,nav,main,footer{padding:1rem;max-width:64rem;margin:auto}nav a{margin-right:1rem}',
    'main{min-height:20rem}.large-print{font-size:200%}.boundary-copy{max-width:42rem;overflow-wrap:anywhere}',
    'label{display:block;font-weight:700;margin-top:1rem}textarea{font:inherit;width:min(100%,36rem);min-height:4.5em;padding:.6rem;resize:vertical}',
    'button{font:inherit;margin:.75rem .5rem .75rem 0;padding:.65rem 1rem}',
    ':focus-visible{outline:.25rem solid #a23e00;outline-offset:.2rem}',
    '#error-summary{border:.2rem solid #a00000;padding:1rem;margin-block:1rem;color:#790000}',
    '#status{min-height:1.5em;font-weight:700}dialog{max-width:32rem;border:.2rem solid #14213d}',
    '@media(max-width:28rem){header,nav,main,footer{padding:.75rem}button{display:block;width:100%;margin-right:0}}',
    '</style></head><body class="',
    bodyClass,
    '" data-contract-id="',
    escapeHtml(spec.contractId),
    '"><a class="skip" href="#main">',
    escapeHtml(copy.skip),
    '</a><header><strong>',
    escapeHtml(copy.brand),
    '</strong></header><nav aria-label="',
    spanish ? 'Principal' : 'Primary',
    '"><a href="#main">',
    escapeHtml(copy.workflow),
    '</a><button id="open-help" type="button">',
    escapeHtml(copy.help),
    '</button></nav>',
    '<main id="main" tabindex="-1"><h1>',
    escapeHtml(spec.title),
    '</h1><p class="boundary-copy">',
    escapeHtml(intro),
    '</p>',
    fallback,
    '<div id="error-summary" role="alert" tabindex="-1" hidden><strong>',
    escapeHtml(copy.error),
    '</strong> <a href="#action-note">',
    escapeHtml(copy.review),
    '</a>.</div><form id="journey-form" novalidate><label for="action-note">',
    escapeHtml(copy.label),
    '</label><p id="action-note-hint">',
    escapeHtml(copy.hint),
    '</p><textarea id="action-note" name="action-note" required aria-describedby="action-note-hint">',
    escapeHtml(fixture.actionNote),
    '</textarea>',
    '<button id="submit-action" type="submit">',
    escapeHtml(spec.actionLabel),
    '</button></form>',
    '<p id="status" role="status" aria-live="polite"></p>',
    '</main><footer>WP-035 · ',
    escapeHtml(copy.footer),
    ' · ',
    escapeHtml(fixture.reference.subjectId),
    '</footer>',
    '<dialog id="help-dialog" aria-labelledby="help-title"><h2 id="help-title">',
    escapeHtml(copy.helpTitle),
    '</h2><p>',
    escapeHtml(copy.helpText),
    '</p><button id="close-help" type="button">',
    escapeHtml(copy.close),
    '</button></dialog>',
    '</body></html>',
  ].join('');
  await page.setContent(html);
  await page.evaluate(
    ({ endpoint, reference, contractId, operationKey, action, copy }) => {
      const form = document.querySelector<HTMLFormElement>('#journey-form');
      const note = document.querySelector<HTMLTextAreaElement>('#action-note');
      const submit = document.querySelector<HTMLButtonElement>('#submit-action');
      const error = document.querySelector<HTMLElement>('#error-summary');
      const status = document.querySelector<HTMLElement>('#status');
      const dialog = document.querySelector<HTMLDialogElement>('#help-dialog');
      const openHelp = document.querySelector<HTMLButtonElement>('#open-help');
      const closeHelp = document.querySelector<HTMLButtonElement>('#close-help');
      if (!form || !note || !submit || !error || !status || !dialog || !openHelp || !closeHelp) {
        throw new Error('accessible shell is incomplete');
      }
      openHelp.addEventListener('click', () => {
        dialog.showModal();
        closeHelp.focus();
      });
      closeHelp.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => openHelp.focus());
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void (async () => {
          if (note.value.trim().length === 0) {
            note.setAttribute('aria-invalid', 'true');
            note.setAttribute('aria-describedby', 'action-note-hint error-summary');
            error.hidden = false;
            status.textContent = copy.validation;
            error.focus();
            return;
          }
          submit.disabled = true;
          status.textContent = copy.submitting;
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                contractId,
                operationKey,
                reference,
                action: { ...action, note: note.value },
              }),
            });
            const result = (await response.json()) as {
              effectCount?: number;
              message?: string;
            };
            if (!response.ok) {
              throw new Error(result.message ?? 'Synthetic service unavailable.');
            }
            document.body.dataset['effectCount'] = String(result.effectCount ?? 0);
            note.removeAttribute('aria-invalid');
            note.setAttribute('aria-describedby', 'action-note-hint');
            error.hidden = true;
            status.textContent = result.message ?? copy.completed;
          } catch (caught) {
            error.hidden = false;
            status.textContent =
              (caught instanceof Error ? caught.message + ' ' : '') + copy.incomplete;
            submit.textContent = copy.retry;
            error.focus();
          } finally {
            submit.disabled = false;
            if (error.hidden) submit.focus();
          }
        })();
      });
    },
    {
      endpoint: spec.endpoint,
      reference: fixture.reference,
      contractId: spec.contractId,
      operationKey: fixture.operationKey,
      action: spec.action,
      copy: {
        submitting: copy.submitting,
        validation: copy.validation,
        incomplete: copy.incomplete,
        retry: copy.retry,
        completed: spanish
          ? 'La acción sintética se completó exactamente una vez.'
          : 'Synthetic action completed exactly once.',
      },
    },
  );
}

export async function readAccessibleSemanticState(page: Page): Promise<SemanticState> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const controls = [...document.querySelectorAll<HTMLElement>('a,button,textarea')].map(
      (element) => {
        if (element instanceof HTMLTextAreaElement) {
          return (
            element.getAttribute('aria-label') ??
            document.querySelector<HTMLLabelElement>('label[for="' + element.id + '"]')
              ?.textContent ??
            ''
          ).trim();
        }
        return (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
      },
    );
    const landmarks = [...document.querySelectorAll<HTMLElement>('header,nav,main,footer')].map(
      (element) => element.tagName.toLowerCase(),
    );
    return {
      contractId: document.body.dataset['contractId'] ?? '',
      heading: document.querySelector('h1')?.textContent?.trim() ?? '',
      landmarks,
      namedControls: controls,
      focusOwner:
        active instanceof HTMLElement
          ? active.id || active.getAttribute('href') || active.tagName.toLowerCase()
          : null,
      status: document.querySelector('#status')?.textContent?.trim() ?? '',
      error: document.querySelector('#error-summary:not([hidden])')?.textContent?.trim() ?? '',
      effectCount: Number(document.body.dataset['effectCount'] ?? '0'),
    };
  });
}
