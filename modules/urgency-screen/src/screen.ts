import { assistiveAiScreen } from './ai-screen-double.js';
import { classifyByKeywords } from './keyword-classifier.js';
import {
  EMERGENCY_LINE,
  KEYWORD_CLASSIFIER_VERSION,
  URGENCY_SCREEN_VERSION,
  type RoutingAction,
  type UrgencyScreenInput,
  type VersionedUrgencyFact,
} from './types.js';

function routingFor(input: {
  readonly urgency: 'urgent' | 'routine';
  readonly afterHours: boolean;
  readonly humanFallback: boolean;
}): RoutingAction {
  if (input.humanFallback) return 'human_review';
  if (input.urgency === 'urgent' && input.afterHours) return 'page_oncall';
  return 'queue_until_open';
}

export function screenInbound(input: UrgencyScreenInput): VersionedUrgencyFact {
  if (input.synthetic !== true) {
    throw new Error('urgency screen accepts synthetic inbound only');
  }
  const keyword = classifyByKeywords({ text: input.text, language: input.language });
  const ai = assistiveAiScreen({
    text: input.text,
    keywordClass: keyword.class,
    killSwitchTripped: input.killSwitchTripped,
  });
  const humanFallback = input.killSwitchTripped || ai.abstained;
  const urgency = humanFallback ? 'urgent' : ai.class;
  const fact: VersionedUrgencyFact = {
    screenVersion: URGENCY_SCREEN_VERSION,
    classifierVersion: `${KEYWORD_CLASSIFIER_VERSION}+${ai.version}`,
    inboundId: input.inboundId,
    class: urgency,
    confidence: humanFallback ? 0 : ai.confidence,
    language: input.language,
    unmatched: input.unmatched,
    afterHours: input.afterHours,
    routing: routingFor({ urgency, afterHours: input.afterHours, humanFallback }),
    emergencyLineRequired: true,
    advisoryOnly: true,
    humanFallback,
    reasons: [
      ...keyword.reasons,
      humanFallback ? 'fallback:human-only' : `ai:${ai.version}:${ai.class}`,
      `channel:${input.channel}`,
      input.unmatched ? 'identity:unmatched' : 'identity:matched',
      `disclaimer:${EMERGENCY_LINE}`,
    ],
    synthetic: true,
  };
  return Object.freeze(fact);
}
