import { describe, expect, it } from 'vitest';

import { OneSendImportWorkbench } from './bindings/wp110-import-workbench-double-v1.js';
import { EXIT_IDENTITY, HubspotExitError, type ExitRecord } from './contracts.js';
import { runExit } from './export-orchestrator.js';

function record(kind: ExitRecord['kind'], id: string): ExitRecord {
  return {
    kind,
    recordId: id,
    email: `${id}@example.test`,
    phone: '5550001111',
    synthetic: true,
  };
}

const complete: readonly ExitRecord[] = [
  record('objects', 'o1'),
  record('owners', 'w1'),
  record('sequences', 's1'),
  record('notes', 'n1'),
];

describe('WP-116 hubspot exit', () => {
  it('exports all four kinds, double-verifies PHI fields, and one-sends', () => {
    const run = runExit(30, complete);
    expect(run.manifest.identity).toBe(EXIT_IDENTITY);
    expect(run.manifest.windowHours).toBe(30);
    expect(run.completeness.complete).toBe(true);
    expect(run.importAck.sentOnce).toBe(true);
    expect(run.importAck.reconciled).toBe(true);
    expect(run.importAck.importedIds).toHaveLength(4);
  });

  it('fails incomplete export', () => {
    expect(() => runExit(24, [record('objects', 'o1')])).toThrow(HubspotExitError);
  });

  it('rejects a second send', () => {
    const bench = new OneSendImportWorkbench();
    bench.importOnce(complete);
    expect(() => bench.importOnce(complete)).toThrow(HubspotExitError);
  });
});
