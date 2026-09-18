import { describe, expect, it } from 'vitest';

import { CommRehearsal, CommRehearsalError } from './rehearsal.js';

describe('CommRehearsal leftovers', () => {
  it('STOP marketing does not block treatment SMS', () => {
    const r = new CommRehearsal();
    r.stop('marketing');
    const sent = r.send({
      scope: 'treatment',
      channel: 'sms',
      body: 'ok',
      containsPhi: false,
      synthetic: true,
    });
    expect(sent.status).toBe('sent');
  });

  it('ordinary email with PHI is rejected', () => {
    const r = new CommRehearsal();
    expect(() =>
      r.send({
        scope: 'operations',
        channel: 'email',
        body: 'phi',
        containsPhi: true,
        synthetic: true,
      }),
    ).toThrow(CommRehearsalError);
  });
});
