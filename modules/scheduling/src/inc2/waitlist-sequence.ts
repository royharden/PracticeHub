import type { WaitlistEntry } from '../types.js';
import type { Increment2Engine } from './engine.js';

export type WaitlistSequenceEvent =
  | { type: 'slot-freed'; recall: boolean; patientId: string; dueAt: string; nowIso: string }
  | { type: 'no-show'; patientId: string; at: string; lockout?: boolean }
  | { type: 'front-desk-arrived'; patientId: string; reassigned: boolean };

export class WaitlistSequence {
  constructor(private readonly engine: Increment2Engine) {}

  handle(
    event: WaitlistSequenceEvent,
    ranked: readonly WaitlistEntry[],
    responseDeadline: string,
  ): {
    offered?: WaitlistEntry;
    revertedToOpen: boolean;
    reversed: boolean;
  } {
    if (event.type === 'slot-freed') {
      if (event.recall) {
        this.engine.recallDue.push({ patientId: event.patientId, dueAt: event.dueAt });
        return { revertedToOpen: false, reversed: false };
      }
      const offer = this.engine.offerFreedSlot(ranked, responseDeadline, event.nowIso);
      if (!offer.offered) {
        for (const entry of ranked) {
          if (entry.state === 'withdrawn') {
            this.engine.closedWaitlist.push(entry.waitlistEntryId);
          }
        }
      }
      const result: {
        offered?: WaitlistEntry;
        revertedToOpen: boolean;
        reversed: boolean;
      } = { revertedToOpen: offer.revertedToOpen, reversed: false };
      if (offer.offered) result.offered = offer.offered;
      return result;
    }
    if (event.type === 'no-show') {
      this.engine.recordNoShow(event.patientId, event.at, event.lockout ?? false);
      return { revertedToOpen: false, reversed: false };
    }
    const reversed = this.engine.reverseNoShowIfArrived(event.patientId, event.reassigned);
    return { revertedToOpen: false, reversed };
  }
}
