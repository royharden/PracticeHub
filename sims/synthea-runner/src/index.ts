/**
 * synthea-runner (WP-029 `adapters_sims: synthea-runner`).
 *
 * A deterministic, synthetic-only stand-in for a real Synthea run. Real Synthea
 * is Apache-2.0 and its output is unrestricted, but running it needs a Java
 * toolchain and a pinned upstream release that this build has not acquired
 * (`SRC acquisitions`). The sim precedent from WP-013/WP-024 applies: the
 * CONSUMER declares the port (`SyntheaRunnerPort` in @practicehub/synthgen) and
 * the sim implements it, so replacing this stub with a real runner changes one
 * implementation and nothing else.
 *
 * What it is NOT: a clinical model. It emits export ROW SHAPES with plausible
 * structure and internally-namespaced codes, because the corpus's job at this
 * layer is to exercise the import, mapping, and quarantine paths — not to be
 * clinically realistic. RSK-05 (synthetic-corpus false fidelity) is answered by
 * acquiring the real generator, and this stub is deliberately easy to tell
 * apart from one: every code it emits is `SYN-*`.
 *
 * Two structural refusals, both below any caller's discretion:
 * - a run request without `synthetic: true` is refused;
 * - the emitted export always carries the watermark, and the importer refuses
 *   an export that does not.
 */
import {
  conditionCatalog,
  createSeededRng,
  createSimulatedClock,
  deriveDomainSeed,
  encounterClasses,
  medicationCatalog,
  type SyntheaConditionRow,
  type SyntheaEncounterRow,
  type SyntheaExport,
  type SyntheaMedicationRow,
  type SyntheaPatientRow,
  type SyntheaRunRequest,
  type SyntheaRunnerPort,
} from '@practicehub/synthgen';

export const syntheaRunnerVersion = 'stub-v1';

export interface SyntheticSyntheaRunnerOptions {
  /**
   * Emit one orphaned row per N patients — a clinical row keyed to a subject
   * the corpus does not know. An acquired-clinic export that maps cleanly is
   * the fiction; the quarantine path has to be exercised by the pinned corpus,
   * not only by a unit test. Zero disables the behaviour.
   */
  readonly orphanRowEveryN?: number;
}

export class SyntheticSyntheaRunner implements SyntheaRunnerPort {
  private readonly orphanRowEveryN: number;

  constructor(options: SyntheticSyntheaRunnerOptions = {}) {
    const every = options.orphanRowEveryN ?? 0;
    if (!Number.isInteger(every) || every < 0) {
      throw new Error('orphanRowEveryN must be a non-negative integer');
    }
    this.orphanRowEveryN = every;
  }

  run(request: SyntheaRunRequest): SyntheaExport {
    if (request.synthetic !== true) {
      throw new Error('synthea-runner refuses a run request that is not synthetic-only');
    }
    if (request.subjectRefs.length !== request.populationSize) {
      throw new Error(
        `synthea-runner: populationSize ${request.populationSize} does not match ` +
          `${request.subjectRefs.length} subject refs`,
      );
    }

    const clock = createSimulatedClock(request.simulatedClockEpoch);
    const rng = createSeededRng(deriveDomainSeed(request.seed, 'synthea-backbone'));

    const patients: SyntheaPatientRow[] = [];
    const conditions: SyntheaConditionRow[] = [];
    const medications: SyntheaMedicationRow[] = [];
    const encounters: SyntheaEncounterRow[] = [];

    request.subjectRefs.forEach((subjectRef, index) => {
      patients.push({
        subjectRef,
        // The importer owns demographic truth; the runner echoes a plausible
        // shape so a mapping mismatch is detectable rather than assumed away.
        birthDate: clock.dateAtDayOffset(-(6_000 + rng.nextInt(20_000))),
        residenceState: 'NV',
        city: 'Ridgeline',
      });

      const conditionCount = 1 + rng.nextInt(3);
      for (let n = 0; n < conditionCount; n += 1) {
        const entry = rng.pick(conditionCatalog);
        conditions.push({
          subjectRef,
          code: entry.code,
          description: entry.description,
          onsetDate: clock.dateAtDayOffset(-rng.nextInt(1_500)),
        });
      }

      if (rng.chance(1, 2)) {
        const entry = rng.pick(medicationCatalog);
        medications.push({
          subjectRef,
          code: entry.code,
          description: entry.description,
          startDate: clock.dateAtDayOffset(-rng.nextInt(700)),
        });
      }

      const encounterCount = 1 + rng.nextInt(4);
      for (let n = 0; n < encounterCount; n += 1) {
        encounters.push({
          subjectRef,
          encounterRef: `sy-enc-${String(index + 1).padStart(4, '0')}-${String(n + 1)}`,
          encounterClass: rng.pick(encounterClasses),
          startDate: clock.dateAtDayOffset(-rng.nextInt(900)),
        });
      }

      if (this.orphanRowEveryN > 0 && (index + 1) % this.orphanRowEveryN === 0) {
        // Keyed to a subject that provably does not exist in the corpus.
        const entry = rng.pick(conditionCatalog);
        conditions.push({
          subjectRef: `sy-orphan-${String(index + 1).padStart(4, '0')}`,
          code: entry.code,
          description: entry.description,
          onsetDate: clock.dateAtDayOffset(-rng.nextInt(1_500)),
        });
      }
    });

    return {
      generator: { name: 'synthea-runner', version: syntheaRunnerVersion },
      seed: request.seed,
      patients,
      conditions,
      medications,
      encounters,
      synthetic: true,
    };
  }
}
