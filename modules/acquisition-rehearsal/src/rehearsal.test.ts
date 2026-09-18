import { describe, expect, it } from 'vitest';

import { boundedPanel, twentySyntheticSubjects } from './panel.js';
import { runAcquisitionRehearsal } from './rehearsal.js';
import { wp110ImportWorkbenchDoubleV1 } from './testing/wp110-import-double-v1.js';
import { wp114CutoverDoubleV1 } from './testing/wp114-cutover-double-v1.js';
import { RehearsalError } from './types.js';

function panel() {
  return boundedPanel({
    tenantId: 'northwind-synthetic',
    panelId: 'panel-20',
    subjects: twentySyntheticSubjects(),
    synthetic: true,
  });
}

describe('runAcquisitionRehearsal', () => {
  it('requires a 20-subject panel', () => {
    expect(() =>
      boundedPanel({
        tenantId: 't1',
        panelId: 'p1',
        subjects: twentySyntheticSubjects().slice(0, 19),
        synthetic: true,
      }),
    ).toThrow(RehearsalError);
  });

  it('freezes only on 20/20 then POST-FREEZE restores and re-keys', () => {
    const run = runAcquisitionRehearsal({
      panel: panel(),
      runId: 'run-ok',
      importer: wp110ImportWorkbenchDoubleV1(),
      cutover: wp114CutoverDoubleV1(false),
      synthetic: true,
    });
    expect(run.imported).toBe(20);
    expect(run.cutOver).toBe(20);
    expect(run.frozen).toBe(true);
    expect(run.restored).toBe(true);
    expect(run.rekeyed).toBe(true);
    expect(run.outcome).toBe('post-freeze-restored');
  });

  it('failed-cutover never freezes and still restore+re-keys', () => {
    const run = runAcquisitionRehearsal({
      panel: panel(),
      runId: 'run-fail',
      importer: wp110ImportWorkbenchDoubleV1(),
      cutover: wp114CutoverDoubleV1(true),
      synthetic: true,
    });
    expect(run.frozen).toBe(false);
    expect(run.outcome).toBe('failed-cutover');
    expect(run.restored).toBe(true);
    expect(run.rekeyed).toBe(true);
    expect(run.workItemId).toBe('wi:rehearsal-fail:run-fail');
  });
});
