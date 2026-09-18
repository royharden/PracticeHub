export interface AthenaDelta {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly sequence: number;
  readonly payloadHash: string;
  readonly synthetic: true;
}

export function replayDeltas(deltas: readonly AthenaDelta[]): readonly AthenaDelta[] {
  const sorted = [...deltas].sort((a, b) => a.sequence - b.sequence);
  const seen = new Set<string>();
  const out: AthenaDelta[] = [];
  for (const delta of sorted) {
    const key = `${delta.tenantId}:${delta.subjectRef}:${String(delta.sequence)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(delta);
  }
  return out;
}
