import type { AuthorityRequest, SchedulingAuthorityPort } from '../ports.js';
import type { AuthorityContext } from '../types.js';

export class RecordingAuthorityPort implements SchedulingAuthorityPort {
  readonly requests: AuthorityRequest[] = [];
  private readonly decisions: AuthorityContext[];

  constructor(decisions: readonly AuthorityContext[] = []) {
    this.decisions = [...decisions];
  }

  async evaluate(request: AuthorityRequest): Promise<AuthorityContext> {
    this.requests.push(structuredClone(request));
    return structuredClone(this.decisions.shift() ?? request.expected);
  }
}
