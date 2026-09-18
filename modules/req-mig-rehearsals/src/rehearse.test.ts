import { describe, expect, it } from 'vitest';

import { RecordingCutover, RecordingWorkbench } from './doubles.js';
import {
  exclusive835ExtendsOverlap,
  missingDeadlineInventoryBlocks,
  privacyBypassForbidden,
  rehearse,
  rewriteWorkbench,
  skippedCommsGateCutover,
  staleExtractBlocksRerun,
  unmappedWorkflowPausesWave,
  unresolvedP0StaysLegacy,
  waveFailRedirectsIntake,
} from './rehearse.js';
import { leftoverReqs, RehearsalRefusal } from './types.js';

describe('WP-129 leftover REQ-MIG rehearsals', () => {
  it('encodes each leftover req against WP-110/114 doubles', () => {
    const ports = { workbench: new RecordingWorkbench(), cutover: new RecordingCutover() };
    expect(rehearse(ports, 'REQ-MIG-001').outcome).toBe('captured');
    expect(rehearse(ports, 'REQ-MIG-007').outcome).toBe('continued');
    expect(rehearse(ports, 'REQ-MIG-008').outcome).toBe('preserved');
    expect(rehearse(ports, 'REQ-MIG-009').outcome).toBe('reconciled');
    expect(rehearse(ports, 'REQ-MIG-019').outcome).toBe('rerun');
    expect(leftoverReqs).toHaveLength(5);
  });

  it('refuses a refused workbench double and a frozen mapping re-run', () => {
    expect(() =>
      rehearse(
        { workbench: new RecordingWorkbench(false), cutover: new RecordingCutover() },
        'REQ-MIG-001',
      ),
    ).toThrow(RehearsalRefusal);
    expect(() =>
      rehearse(
        { workbench: new RecordingWorkbench(), cutover: new RecordingCutover(true) },
        'REQ-MIG-019',
      ),
    ).toThrow(/frozen cutover mapping/);
  });

  it('never rewrites the migration workbench', () => {
    expect(() => rewriteWorkbench()).toThrow(/do not rewrite migration-workbench/);
  });

  it('encodes leftover AC/EX fail-closed rehearsals', () => {
    expect(unresolvedP0StaysLegacy().outcome).toBe('blocked');
    expect(() => privacyBypassForbidden()).toThrow(/privacy/);
    expect(waveFailRedirectsIntake().req).toBe('REQ-MIG-007');
    expect(() => unmappedWorkflowPausesWave()).toThrow(/pauses the wave/);
    expect(() => missingDeadlineInventoryBlocks()).toThrow(/deadline inventory/);
    expect(() => exclusive835ExtendsOverlap()).toThrow(/835/);
    expect(() => staleExtractBlocksRerun()).toThrow(/stale extract/);
    expect(() => skippedCommsGateCutover()).toThrow(/notification/);
  });
});
