import type { Channel, EquivalentOption, Offer } from './types.js';
import { SchRehearsalError } from './types.js';

const channels: readonly Channel[] = ['sms', 'email', 'voice'];

/** REQ-SCH-002.AC3: equivalent options share a slot, differ by label. */
export function presentEquivalentOptions(
  options: readonly EquivalentOption[],
): readonly EquivalentOption[] {
  if (options.length === 0) throw new SchRehearsalError('EMPTY_OPTIONS');
  const slots = new Set(options.map((option) => option.slotRef));
  if (slots.size !== 1) throw new SchRehearsalError('DUPLICATE_SLOT');
  return options;
}

/** REQ-SCH-003.AC2: preferred-channel confirmation as a token, not live canSend. */
export function confirmPreferredChannel(channel: string): Channel {
  if (!channels.includes(channel as Channel)) throw new SchRehearsalError('UNKNOWN_CHANNEL');
  return channel as Channel;
}

/** REQ-SCH-021: same-day multi-offer candidates. */
export function sameDayOffers(day: string, offers: readonly Offer[]): readonly Offer[] {
  const sameDay = offers.filter((offer) => offer.expiresAt.startsWith(day));
  if (sameDay.length === 0) throw new SchRehearsalError('NO_SAME_DAY');
  return sameDay;
}

/** REQ-SCH-022: expired offer cannot be accepted. */
export function acceptOffer(offer: Offer, now: string): Offer {
  if (now >= offer.expiresAt) throw new SchRehearsalError('EXPIRED_OFFER');
  return offer;
}
