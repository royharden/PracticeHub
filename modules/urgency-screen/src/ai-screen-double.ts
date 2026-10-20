import {
  compactReading,
  normalizeForScreen,
  normalizeV1ForScreen,
  normalizedReadings,
} from './normalize.js';
import { AI_SCREEN_DOUBLE_VERSION, type UrgencyClass } from './types.js';

const ESCALATION_PHRASES: readonly string[] = [
  'worst headache',
  'thunderclap',
  'lips blue',
  'labios azules',
].map(normalizeForScreen);

/**
 * Model-sim assistive screen (D5.5 dev). It may escalate routine → urgent.
 * It must never downgrade a keyword-urgent decision (false-negative floor).
 * v4 matches each phrase as a substring of the raw lower-cased text (as the landed double did),
 * of the normalize.v1 text (as a2 did), of both normalize readings and of the compact reading,
 * so it escalates whenever any earlier version would have.
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
    return {
      class: input.keywordClass,
      confidence: 0,
      abstained: true,
      version: AI_SCREEN_DOUBLE_VERSION,
    };
  }
  if (input.keywordClass === 'urgent') {
    return { class: 'urgent', confidence: 1, abstained: false, version: AI_SCREEN_DOUBLE_VERSION };
  }
  const haystacks = [
    input.text.toLowerCase(),
    normalizeV1ForScreen(input.text),
    ...normalizedReadings(input.text),
  ];
  const compact = compactReading(input.text);
  const escalate = ESCALATION_PHRASES.some(
    (phrase) =>
      haystacks.some((haystack) => haystack.includes(phrase)) ||
      (compact !== null && compact.includes(phrase.replaceAll(' ', ''))),
  );
  if (escalate) {
    return {
      class: 'urgent',
      confidence: 0.7,
      abstained: false,
      version: AI_SCREEN_DOUBLE_VERSION,
    };
  }
  return { class: 'routine', confidence: 0.4, abstained: false, version: AI_SCREEN_DOUBLE_VERSION };
}
