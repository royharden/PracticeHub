import { OneSendImportWorkbench } from './bindings/wp110-import-workbench-double-v1.js';
import { assertComplete, verifyCompleteness } from './completeness.js';
import {
  EXIT_IDENTITY,
  HubspotExitError,
  type CompletenessReport,
  type ExitRecord,
  type ExportManifest,
  type ImportAck,
} from './contracts.js';

export interface ExitRun {
  readonly manifest: ExportManifest;
  readonly completeness: CompletenessReport;
  readonly importAck: ImportAck;
}

export function exportWindow(hours: 24 | 30, records: readonly ExitRecord[]): ExportManifest {
  if (hours !== 24 && hours !== 30) {
    throw new HubspotExitError('BAD_WINDOW', String(hours));
  }
  if (records.some((record) => record.synthetic !== true)) {
    throw new HubspotExitError('NON_SYNTHETIC', 'phi-live-forbidden');
  }
  return { identity: EXIT_IDENTITY, windowHours: hours, records, synthetic: true };
}

export function runExit(hours: 24 | 30, records: readonly ExitRecord[]): ExitRun {
  const manifest = exportWindow(hours, records);
  const completeness = verifyCompleteness(manifest.records);
  assertComplete(completeness);
  const workbench = new OneSendImportWorkbench();
  const importAck = workbench.importOnce(manifest.records);
  return { manifest, completeness, importAck };
}
