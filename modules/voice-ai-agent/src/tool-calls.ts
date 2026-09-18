import { VoiceAgentError, type ToolName } from './contracts.js';

const allowlist: readonly ToolName[] = [
  'book_routine',
  'capture_refill_intake',
  'transfer_oncall',
  'queue_morning_handoff',
];

const clinical = new Set(['diagnose', 'prescribe', 'renew', 'substitute']);

export function assertAllowlistedTool(name: string): ToolName {
  if (clinical.has(name)) {
    throw new VoiceAgentError('CLINICAL_JUDGMENT_FORBIDDEN', name);
  }
  if ((allowlist as readonly string[]).includes(name)) {
    return name as ToolName;
  }
  throw new VoiceAgentError('TOOL_NOT_ALLOWLISTED', name);
}

export function assertNoClinicalJudgment(name: string, afterHoursRefill: boolean): void {
  if (clinical.has(name)) {
    throw new VoiceAgentError('CLINICAL_JUDGMENT_FORBIDDEN', name);
  }
  if (
    afterHoursRefill &&
    name !== 'capture_refill_intake' &&
    name !== 'transfer_oncall' &&
    name !== 'queue_morning_handoff'
  ) {
    throw new VoiceAgentError('CLINICAL_JUDGMENT_FORBIDDEN', name);
  }
}
