import { applyBargeIn } from './barge-in.js';
import { type CanSendState } from './bindings/wp018-cansend-double-v1.js';
import { assertSyntheticGateway } from './bindings/wp100-gateway-double-v1.js';
import {
  assertOutboundAllowed,
  defaultSponsorPolicy,
  type SponsorOutboundPolicy,
} from './consent-gate.js';
import {
  VoiceAgentError,
  type Direction,
  type RelayTurn,
  type VoiceSessionSnapshot,
} from './contracts.js';
import { withMorningHandoff, withWarmTransfer } from './escalation.js';
import { VoiceKillSwitch } from './kill-switch.js';
import { assertAllowlistedTool, assertNoClinicalJudgment } from './tool-calls.js';

export interface StartRelayInput {
  readonly sessionId: string;
  readonly direction: Direction;
  readonly purpose: string;
  readonly consentState: { readonly currentState: CanSendState } | null;
  readonly ledgerAvailable: boolean;
  readonly sponsorPolicy?: SponsorOutboundPolicy;
  readonly authenticated: boolean;
  readonly afterHours: boolean;
  readonly language?: string;
  readonly synthetic: true;
}

const lifeThreat = /\b(911|chest pain|not breathing|suicide)\b/i;

export class ConversationRelaySession {
  #snapshot: VoiceSessionSnapshot;
  readonly #kill = new VoiceKillSwitch();

  public constructor(input: StartRelayInput) {
    assertSyntheticGateway(input.synthetic);
    assertOutboundAllowed(
      input.direction,
      input.sponsorPolicy ?? defaultSponsorPolicy,
      input.consentState,
      input.ledgerAvailable,
    );
    this.#snapshot = {
      sessionId: input.sessionId,
      direction: input.direction,
      disclosedAi: true,
      optOutOffered: true,
      outboundAllowed: input.direction === 'outbound',
      interrupted: false,
      toolCalls: [],
      retryCount: 0,
      language: input.language ?? 'en',
      channel: 'voice',
      warmTransfer: false,
      emergencyFlag: false,
      qaRequired: false,
      qaDismissed: false,
      qaReviewerDecision: null,
      morningWorklist: [],
      authenticated: input.authenticated,
      afterHours: input.afterHours,
      callbackTask: false,
      advise911: false,
      killSwitchEngaged: false,
      comprehensionUncertain: false,
      refillNotApproval: false,
      handoff: null,
      turns: [
        {
          kind: 'agent_speech',
          text: 'This call uses an AI voice. Responsible party: PracticeHub. Press 9 to opt out.',
        },
        { kind: 'opt_out', text: 'opt-out-offered' },
      ],
      synthetic: true,
    };
  }

  public snapshot(): VoiceSessionSnapshot {
    return this.#snapshot;
  }

  public kill(): VoiceSessionSnapshot {
    this.#kill.engage();
    this.#snapshot = { ...this.#snapshot, killSwitchEngaged: true };
    return this.#snapshot;
  }

  public bargeIn(userText: string): VoiceSessionSnapshot {
    this.#kill.assertLive();
    this.#snapshot = {
      ...this.#snapshot,
      interrupted: true,
      turns: applyBargeIn(this.#snapshot.turns, userText),
    };
    if (lifeThreat.test(userText)) {
      this.#snapshot = withWarmTransfer(this.#snapshot, true);
    }
    return this.#snapshot;
  }

  public switchAccessibleChannel(confidence: number): VoiceSessionSnapshot {
    this.#kill.assertLive();
    if (confidence >= 0.5) {
      return this.#snapshot;
    }
    this.#snapshot = {
      ...this.#snapshot,
      language: this.#snapshot.language,
      channel: 'sms',
      comprehensionUncertain: true,
      turns: [
        ...this.#snapshot.turns,
        { kind: 'agent_speech', text: 'switching-channel-preserving-language' },
      ],
    };
    return this.#snapshot;
  }

  public invokeTool(name: string, afterHoursRefill: boolean): VoiceSessionSnapshot {
    this.#kill.assertLive();
    if (this.#snapshot.optOutOffered !== true) {
      throw new VoiceAgentError('DISCLOSURE_INCOMPLETE', name);
    }
    if (this.#snapshot.comprehensionUncertain && name === 'book_routine') {
      throw new VoiceAgentError('AGREEMENT_WHILE_UNCERTAIN', name);
    }
    const toolName = assertAllowlistedTool(name);
    if (toolName === 'capture_refill_intake' && this.#snapshot.authenticated !== true) {
      throw new VoiceAgentError('REFILL_UNAUTHENTICATED', name);
    }
    assertNoClinicalJudgment(toolName, afterHoursRefill || this.#snapshot.afterHours);
    const turn: RelayTurn = { kind: 'tool', text: toolName, toolName };
    this.#snapshot = {
      ...this.#snapshot,
      toolCalls: [...this.#snapshot.toolCalls, toolName],
      turns: [...this.#snapshot.turns, turn],
      refillNotApproval: toolName === 'capture_refill_intake',
    };
    if (toolName === 'transfer_oncall') {
      this.#snapshot = withWarmTransfer(this.#snapshot, false);
    }
    if (toolName === 'queue_morning_handoff') {
      this.#snapshot = withMorningHandoff(this.#snapshot);
    }
    return this.#snapshot;
  }

  public toolOutage(): VoiceSessionSnapshot {
    this.#kill.assertLive();
    if (this.#snapshot.retryCount > 0) {
      throw new VoiceAgentError('RETRY_LOOP_FORBIDDEN', this.#snapshot.sessionId);
    }
    this.#snapshot = {
      ...this.#snapshot,
      retryCount: 1,
      callbackTask: true,
      channel: 'human',
      turns: [...this.#snapshot.turns, { kind: 'handoff', text: 'incomplete-tool-callback' }],
    };
    return this.#snapshot;
  }

  public dismissQa(): VoiceSessionSnapshot {
    if (this.#snapshot.qaRequired && this.#snapshot.qaReviewerDecision === null) {
      throw new VoiceAgentError('QA_CANNOT_DISMISS', this.#snapshot.sessionId);
    }
    this.#snapshot = { ...this.#snapshot, qaDismissed: true };
    return this.#snapshot;
  }

  public recordQaDecision(decision: string): VoiceSessionSnapshot {
    this.#snapshot = { ...this.#snapshot, qaReviewerDecision: decision };
    return this.#snapshot;
  }

  public bookRoutine(): VoiceSessionSnapshot {
    return this.invokeTool('book_routine', this.#snapshot.afterHours);
  }
}
