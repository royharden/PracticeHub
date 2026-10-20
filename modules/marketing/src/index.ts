export { attribute } from './attribution.js';
export type { AttributionRow, AttributionTotals } from './attribution.js';
export { canSend } from './cansend.js';
export type { MarketingSendDecision } from './cansend.js';
export { consentBelongsTo, runJourney } from './journey.js';
export type {
  Campaign,
  JourneyRefusal,
  JourneyRun,
  RecordedSend,
  Segment,
  Template,
} from './journey.js';
export { memberInSegment, renderCanSpamTemplate } from './segments.js';
export type {
  CanSpamContext,
  DemographicField,
  DemographicProfile,
  SegmentRule,
} from './segments.js';
export type { Wp070CrmMember } from './placeholder.js';
export { applyBounce, deliver, isSuppressed, partitionAllows } from './suppression.js';
export type { BounceResult, HouseholdMember, Suppression } from './suppression.js';
export {
  applyBounceAndSuppress,
  applyComplaint,
  defaultPostureThresholds,
  deliverToMember,
  DeliverabilityPosture,
  SuppressionStore,
} from './deliverability.js';
export type {
  DeliveredSend,
  DeliveryBlock,
  MemberChannelDirectory,
  PostureThresholds,
  SenderPosture,
} from './deliverability.js';
