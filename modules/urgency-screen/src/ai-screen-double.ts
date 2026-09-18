import { AI_SCREEN_DOUBLE_VERSION, type UrgencyClass } from './types.js';

/**
 * Model-sim assistive screen (D5.5 dev). It may escalate routine → urgent.
 * It must never downgrade a keyword-urgent decision (false-negative floor).
 */
export function assistiveAiScreen(input: {
  readonly text: string;
  readonly keywordClass: UrgencyClass;
  readonly killSwitchTripped: boolean;
}): {
  readonly class: UrgencyClass;
  readonly confidence: number;
  readonly abstained: boolean;
  readonly version: typeof AI_SCREEN_DOUBLE_VERSION;
} {
  if (input.killSwitchTripped) {
    return { class: input.keywordClass, confidence: 0, abstained: true, version: AI_SCREEN_DOUBLE_VERSION };
  }
  if (input.keywordClass === 'urgent') {
    return { class: 'urgent', confidence: 1, abstained: false, version: AI_SCREEN_DOUBLE_VERSION };
  }
  const haystack = input.text.toLowerCase();
  const escalate =
    haystack.includes('worst headache') ||
    haystack.includes('lips blue') ||
    haystack.includes('labios azules');
  if (escalate) {
    return { class: 'urgent', confidence: 0.7, abstained: false, version: AI_SCREEN_DOUBLE_VERSION };
  }
  return { class: 'routine', confidence: 0.4, abstained: false, version: AI_SCREEN_DOUBLE_VERSION };
}
