import { VoiceAgentError } from './contracts.js';

export class VoiceKillSwitch {
  #engaged = false;

  public get engaged(): boolean {
    return this.#engaged;
  }

  public engage(): void {
    this.#engaged = true;
  }

  public assertLive(): void {
    if (this.#engaged) {
      throw new VoiceAgentError('KILL_SWITCH_ENGAGED', 'session-halted');
    }
  }
}
