import type { QleKind, RosterRow } from './types.js';
import { EmployerGroupError } from './types.js';
import type { RosterStore } from './roster.js';

export interface QleEvent {
  readonly employeeId: string;
  readonly kind: QleKind;
  readonly at: string;
  readonly synthetic: true;
}

export class QleCobra {
  readonly events: QleEvent[] = [];

  public constructor(private readonly roster: RosterStore) {}

  public ingest(employerRef: string, event: QleEvent): RosterRow {
    const row = this.roster
      .activeRows()
      .find((candidate) => candidate.employeeId === event.employeeId);
    if (row === undefined && event.kind !== 'hire') {
      throw new EmployerGroupError('QLE for unknown employee', 'unknown-employee');
    }
    this.events.push(Object.freeze({ ...event }));
    if (event.kind === 'termination' || event.kind === 'cobra-elect') {
      if (row === undefined) {
        throw new EmployerGroupError('QLE for unknown employee', 'unknown-employee');
      }
      const next: RosterRow = Object.freeze({
        ...row,
        status: event.kind === 'cobra-elect' ? 'cobra' : 'terminated',
        terminationDate: event.kind === 'termination' ? event.at : row.terminationDate,
      });
      const rest = this.roster
        .activeRows()
        .filter((candidate) => candidate.employeeId !== row.employeeId);
      this.roster.preview(employerRef, event.kind === 'termination' ? rest : [...rest, next]);
      this.roster.confirm(employerRef, event.at);
      return next;
    }
    if (row === undefined) {
      throw new EmployerGroupError('hire QLE requires a staged roster row', 'hire-needs-row');
    }
    return row;
  }
}
