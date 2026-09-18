export interface SimulatedVoiceEffect {
  readonly tenantId: string;
  readonly callId: string;
  readonly operation: 'dial' | 'hangup' | 'voicemail-drop';
  readonly idempotencyKey: string;
  readonly synthetic: true;
}

export class TwilioSimVoice {
  private readonly effects = new Map<string, SimulatedVoiceEffect>();

  public dispatch(effect: SimulatedVoiceEffect): SimulatedVoiceEffect {
    if (effect.synthetic !== true) {
      throw new Error('twilio-sim-voice accepts synthetic effects only');
    }
    const key = `${effect.tenantId}:${effect.idempotencyKey}`;
    const existing = this.effects.get(key);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(effect)) {
        throw new Error('idempotency key reused with a different payload');
      }
      return existing;
    }
    this.effects.set(key, effect);
    return effect;
  }
}
