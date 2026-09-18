import { HubspotExitError, type ExitRecord, type ImportAck } from '../contracts.js';

export const wp110ImportWorkbenchDoubleV1 = {
  contract: 'practicehub.wp110-import-workbench-double',
  version: 1 as const,
  parity: 'versioned-double' as const,
};

export class OneSendImportWorkbench {
  #sent = false;

  public importOnce(records: readonly ExitRecord[]): ImportAck {
    if (this.#sent) {
      throw new HubspotExitError('SECOND_SEND_FORBIDDEN', 'one-send-capable-system');
    }
    this.#sent = true;
    return {
      sentOnce: true,
      reconciled: records.every((record) => record.synthetic === true),
      importedIds: records.map((record) => record.recordId),
    };
  }
}
