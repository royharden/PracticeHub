import type { CutoverHarnessPort, ImportWorkbenchPort } from './ports.js';
import { REHEARSAL_PANEL_SIZE, RehearsalError, requireSynthetic } from './types.js';
import type { RehearsalPanel, RehearsalRun } from './types.js';

export function runAcquisitionRehearsal(input: {
  readonly panel: RehearsalPanel;
  readonly runId: string;
  readonly importer: ImportWorkbenchPort;
  readonly cutover: CutoverHarnessPort;
  readonly synthetic: boolean;
}): RehearsalRun {
  requireSynthetic(input.synthetic);
  if (input.runId.trim() === '') {
    throw new RehearsalError('runId is required');
  }
  const imported = input.importer.importPanel({
    tenantId: input.panel.tenantId,
    panelId: input.panel.panelId,
    subjectRefs: input.panel.subjects.map((subject) => subject.subjectRef),
  });
  const cut = input.cutover.cutOver({
    tenantId: input.panel.tenantId,
    panelId: input.panel.panelId,
    imported: imported.imported,
  });

  if (
    cut.failed ||
    cut.cutOver !== REHEARSAL_PANEL_SIZE ||
    imported.imported !== REHEARSAL_PANEL_SIZE
  ) {
    const restored = input.cutover.restoreAndRekey({
      tenantId: input.panel.tenantId,
      panelId: input.panel.panelId,
    });
    return {
      tenantId: input.panel.tenantId,
      runId: input.runId,
      panelId: input.panel.panelId,
      imported: imported.imported,
      cutOver: cut.cutOver,
      outcome: 'failed-cutover',
      frozen: false,
      restored: restored.restored,
      rekeyed: restored.rekeyed,
      workItemId: `wi:rehearsal-fail:${input.runId}`,
      synthetic: true,
    };
  }

  const postFreeze = input.cutover.restoreAndRekey({
    tenantId: input.panel.tenantId,
    panelId: input.panel.panelId,
  });
  return {
    tenantId: input.panel.tenantId,
    runId: input.runId,
    panelId: input.panel.panelId,
    imported: imported.imported,
    cutOver: cut.cutOver,
    outcome: 'post-freeze-restored',
    frozen: true,
    restored: postFreeze.restored,
    rekeyed: postFreeze.rekeyed,
    workItemId: null,
    synthetic: true,
  };
}
