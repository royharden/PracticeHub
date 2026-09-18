import {
  ehiDeltaDoubleVersion,
  importWorkbenchDoubleVersion,
  type EhiDeltaDouble,
  type ImportWorkbenchDouble,
} from './ports.js';

export class RecordingImportWorkbench implements ImportWorkbenchDouble {
  public readonly interfaceVersion = importWorkbenchDoubleVersion;
  public readonly calls: string[] = [];
  public constructor(private readonly accepted = true) {}
  public dryRun(panelRef: string): { readonly accepted: boolean; readonly findings: number } {
    this.calls.push(panelRef);
    return { accepted: this.accepted, findings: this.accepted ? 0 : 1 };
  }
}

export class RecordingEhiDelta implements EhiDeltaDouble {
  public readonly interfaceVersion = ehiDeltaDoubleVersion;
  readonly #remaining = new Map<string, number>();
  public seed(panelRef: string, remaining: number): void {
    this.#remaining.set(panelRef, remaining);
  }
  public remaining(panelRef: string): number {
    return this.#remaining.get(panelRef) ?? 0;
  }
  public drainOne(panelRef: string): number {
    const next = Math.max(0, this.remaining(panelRef) - 1);
    this.#remaining.set(panelRef, next);
    return next;
  }
}
