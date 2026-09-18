export type ClauseDisposition =
  | { readonly clause: string; readonly disposition: 'encoded'; readonly pointer: string }
  | { readonly clause: string; readonly disposition: 'forwarded'; readonly fwdId: string };

/**
 * WP-033 owns REQ-PLAT-018 (loop half named by FWD-SIM-033-INJECT).
 * Other REQ-PLAT-* rows are not this package's clauses.
 */
export const reqPlat018Dispositions: readonly ClauseDisposition[] = [
  {
    clause: 'REQ-PLAT-018 AC1',
    disposition: 'encoded',
    pointer:
      'src/harness.ts runLoopHardeningExecution records applicationKey, effects, receipts, attempts, and railResponses',
  },
  {
    clause: 'REQ-PLAT-018 AC2',
    disposition: 'encoded',
    pointer:
      'src/loop-hardening.test.ts X-03/X-04 cases; harness WP033_DUPLICATE_EXTERNAL_EFFECT and WP033_DUPLICATE_PRODUCT_TRANSITION',
  },
  {
    clause: 'REQ-PLAT-018 AC3',
    disposition: 'encoded',
    pointer:
      'X-02 after-effect-before-receipt recover paths plus ownedException; WP033_SILENT_LOSS',
  },
  {
    clause: 'REQ-PLAT-018 EX1',
    disposition: 'encoded',
    pointer:
      'harness WP033_BLIND_RESEND; recover() uses persisted unknown rather than a primitive-suffixed key',
  },
];

export function assertReqPlat018DispositionsComplete(): void {
  const expected = ['REQ-PLAT-018 AC1', 'REQ-PLAT-018 AC2', 'REQ-PLAT-018 AC3', 'REQ-PLAT-018 EX1'];
  const seen = reqPlat018Dispositions.map((row) => row.clause);
  if (seen.length !== expected.length || expected.some((clause, index) => seen[index] !== clause)) {
    throw new Error('WP033_ACEX_CLAUSE_GAP');
  }
  for (const row of reqPlat018Dispositions) {
    if (row.disposition === 'encoded' && row.pointer.length === 0) {
      throw new Error(`WP033_ACEX_EMPTY_POINTER:${row.clause}`);
    }
    if (row.disposition === 'forwarded' && !row.fwdId.startsWith('FWD-')) {
      throw new Error(`WP033_ACEX_FWD_MISSING:${row.clause}`);
    }
  }
}
