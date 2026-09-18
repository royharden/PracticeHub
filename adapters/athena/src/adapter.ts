import { AthenaSimCache } from './cache.js';
import { Wp060ClinicalContractsDouble } from './contracts-double.js';
import { eligibilityFailVisible } from './eligibility.js';
import type { RecordingConsentRecord } from './recording-consent.js';
import { holdResultsWithoutConsent, releaseResults } from './results-release.js';

export class AthenaSimAdapter {
  readonly id = 'athena-sim' as const;
  readonly mode = 'synthetic-local' as const;
  readonly cache = new AthenaSimCache();
  readonly contracts = new Wp060ClinicalContractsDouble();

  public observe(input: {
    readonly tenantId: string;
    readonly subjectRef: string;
    readonly resourceType: string;
    readonly id: string;
  }): void {
    this.contracts.accept(input);
  }

  public degradedDrill(apiDown: boolean, nowStale: boolean): 'fail-visible' | 'eligible' {
    return eligibilityFailVisible(apiDown, nowStale);
  }

  public releaseIfConsented(consent: RecordingConsentRecord, resultId: string) {
    if (consent.state !== 'granted') {
      return holdResultsWithoutConsent(consent.tenantId, consent.subjectRef, resultId);
    }
    return releaseResults(consent, resultId);
  }
}
