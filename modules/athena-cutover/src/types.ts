export const waveStates = [
  'planned',
  'rehearsing',
  'frozen',
  'read-only-tail',
  'complete',
  'rolled-back',
  'quarantined',
] as const;
export type WaveState = (typeof waveStates)[number];

export const cutoverCeiling = 'shadow-ready' as const;

export interface CutoverWave {
  readonly tenantId: string;
  readonly waveId: string;
  readonly panelRef: string;
  readonly state: WaveState;
  readonly deltaRemaining: number;
  readonly frozenAt: string | null;
  readonly athenaReadOnly: boolean;
  readonly lastRestoreKey: string | null;
  readonly quarantineReason: string | null;
  readonly synthetic: true;
}

export class CutoverRefusal extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CutoverRefusal';
  }
}
