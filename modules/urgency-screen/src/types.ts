export const URGENCY_SCREEN_VERSION = 'urgency-screen.v1' as const;
export const KEYWORD_CLASSIFIER_VERSION = 'keyword-classifier.v1' as const;
export const AI_SCREEN_DOUBLE_VERSION = 'ai-screen-double.v1' as const;
export const EMERGENCY_LINE =
  'If this is an emergency call 911 or go to the nearest emergency room.' as const;

export type UrgencyClass = 'urgent' | 'routine';
export type ScreenLanguage = 'en' | 'es' | 'unknown';
export type InboundChannel = 'sms' | 'voice-transcript' | 'portal' | 'webchat';
export type RoutingAction = 'page_oncall' | 'queue_until_open' | 'human_review';

export interface UrgencyScreenInput {
  readonly tenantId: string;
  readonly inboundId: string;
  readonly receivedAt: string;
  readonly channel: InboundChannel;
  readonly language: ScreenLanguage;
  readonly text: string;
  readonly unmatched: boolean;
  readonly afterHours: boolean;
  readonly killSwitchTripped: boolean;
  readonly synthetic: true;
}

export interface VersionedUrgencyFact {
  readonly screenVersion: typeof URGENCY_SCREEN_VERSION;
  readonly classifierVersion: string;
  readonly inboundId: string;
  readonly class: UrgencyClass;
  readonly confidence: number;
  readonly language: ScreenLanguage;
  readonly unmatched: boolean;
  readonly afterHours: boolean;
  readonly routing: RoutingAction;
  readonly emergencyLineRequired: true;
  readonly advisoryOnly: true;
  readonly humanFallback: boolean;
  readonly reasons: readonly string[];
  readonly synthetic: true;
}

/** WP-044 consumes this fact; this package never writes the thread aggregate. */
export interface ThreadUrgencyPort {
  recordUrgencyFact(fact: VersionedUrgencyFact): void;
}

/** WP-023 consumes page intent; this package never resolves coverage. */
export interface OnCallPagePort {
  requestPage(input: { readonly inboundId: string; readonly fact: VersionedUrgencyFact }): void;
}
