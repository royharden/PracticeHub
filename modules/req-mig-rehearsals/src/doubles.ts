import {
  cutoverDoubleVersion,
  workbenchDoubleVersion,
  type CutoverDouble,
  type WorkbenchDouble,
} from './ports.js';

export class RecordingWorkbench implements WorkbenchDouble {
  public readonly interfaceVersion = workbenchDoubleVersion;
  public constructor(private readonly accepted = true) {}
  public dryRunAccepted(): boolean {
    return this.accepted;
  }
}

export class RecordingCutover implements CutoverDouble {
  public readonly interfaceVersion = cutoverDoubleVersion;
  public constructor(private readonly isFrozen = false) {}
  public frozen(): boolean {
    return this.isFrozen;
  }
}
