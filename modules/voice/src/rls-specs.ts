import type { RlsTableSpec } from '@practicehub/platform-core';

export const voiceRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'voice', table: 'call_session', kind: 'tenant-scoped' },
  { schema: 'voice', table: 'recording_decision', kind: 'tenant-scoped' },
  { schema: 'voice', table: 'voicemail_triage', kind: 'tenant-scoped' },
];
