export type CommScope = 'marketing' | 'treatment' | 'operations';
export type CommChannel = 'sms' | 'email';

export class CommRehearsalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CommRehearsalError';
  }
}

export class CommRehearsal {
  private readonly stopped = new Set<CommScope>();
  private campaignStatus: 'ok' | '10dlc-rejected' | 'recovered' = 'ok';
  private quietHours = false;

  public stop(scope: CommScope): void {
    this.stopped.add(scope);
  }

  public setQuietHours(active: boolean): void {
    this.quietHours = active;
  }

  public reject10dlc(): void {
    this.campaignStatus = '10dlc-rejected';
  }

  public recover10dlc(): void {
    if (this.campaignStatus !== '10dlc-rejected') {
      throw new CommRehearsalError('no 10DLC rejection to recover');
    }
    this.campaignStatus = 'recovered';
  }

  public send(input: {
    readonly scope: CommScope;
    readonly channel: CommChannel;
    readonly body: string;
    readonly containsPhi: boolean;
    readonly synthetic: true;
  }): { readonly status: 'sent' | 'deferred' | 'failed-undeliverable'; readonly audit: string } {
    if (input.synthetic !== true) {
      throw new CommRehearsalError('rehearsals must be synthetic');
    }
    if (this.stopped.has(input.scope)) {
      throw new CommRehearsalError(`post-STOP send prevented for ${input.scope}`);
    }
    if (input.channel === 'email' && input.containsPhi) {
      throw new CommRehearsalError('ordinary email must not contain PHI');
    }
    if (input.scope === 'marketing' && this.campaignStatus === '10dlc-rejected') {
      throw new CommRehearsalError('marketing send blocked until 10DLC recovery');
    }
    if (this.quietHours) {
      return { status: 'deferred', audit: 'quiet-hours-deferred' };
    }
    return { status: 'sent', audit: `sent:${input.scope}:${input.channel}` };
  }

  public undeliverableSms(): {
    readonly status: 'failed-undeliverable';
    readonly next: 'alternate-contact';
  } {
    return { status: 'failed-undeliverable', next: 'alternate-contact' };
  }

  public deliverDeferred(): { readonly status: 'sent'; readonly audit: 'quiet-hours-released' } {
    this.quietHours = false;
    return { status: 'sent', audit: 'quiet-hours-released' };
  }
}
