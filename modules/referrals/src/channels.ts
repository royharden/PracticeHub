/**
 * Outbound referral rails for WP-074: a fax-sim double and an esp-sim
 * (electronic specialist portal) double. Both are deterministic, synthetic and
 * local: a scenario fixes the transport outcome, and the inbound side is a
 * scripted list of partner events. `sims/fax-sim` today models only the
 * inbound fax rail (WP-024) and no esp-sim package exists, so these doubles
 * implement the module-declared `OutboundChannelPort` until those rails are
 * built; see `contracts/referral-api.md` for the replacement note.
 */

import {
  ReferralError,
  type Channel,
  type OutboundChannelPort,
  type OutboundRequest,
  type PartnerEvent,
  type PartnerEventKind,
  type TransmissionReceipt,
  type TransmissionStatus,
} from './contracts.js';

export type ChannelScenario = 'delivered' | 'busy' | 'invalid-address';

function simChannel(channel: Channel, scenario: ChannelScenario): OutboundChannelPort {
  let sequence = 0;
  return {
    channel,
    send(request: OutboundRequest): TransmissionReceipt {
      if (!request.address.startsWith(channel === 'fax' ? 'synthetic-fax:' : 'esp:')) {
        throw new ReferralError('CHANNEL_ADDRESS', `${channel} cannot reach ${request.address}`);
      }
      sequence += 1;
      const status: TransmissionStatus = scenario;
      return {
        transmissionId: `${channel}-sim:${request.referralId}:${String(sequence)}`,
        channel,
        status,
        at: request.at,
        synthetic: true,
      };
    },
  };
}

export function createFaxSim(scenario: ChannelScenario = 'delivered'): OutboundChannelPort {
  return simChannel('fax', scenario);
}

export function createEspSim(scenario: ChannelScenario = 'delivered'): OutboundChannelPort {
  return simChannel('esp', scenario);
}

export interface ScriptedEvent {
  readonly kind: PartnerEventKind;
  readonly at: string;
  readonly detail?: string;
  readonly consultNoteRef?: string;
}

/**
 * Turn a partner script into inbound events for one referral. Fax-only
 * partners have no structured feed, so their events carry channel `fax` and
 * stand for a coordinator transcribing a confirmation page (REQ-REF-013 EX5).
 */
export function partnerEvents(
  channel: Channel | 'manual',
  referralId: string,
  patientRef: string,
  script: readonly ScriptedEvent[],
): readonly PartnerEvent[] {
  return script.map((step, index) => ({
    kind: step.kind,
    referralId,
    patientRef,
    at: step.at,
    channel,
    evidenceRef: `${channel}-evidence:${referralId}:${String(index + 1)}`,
    detail: step.detail ?? step.kind,
    consultNoteRef: step.consultNoteRef ?? null,
  }));
}
