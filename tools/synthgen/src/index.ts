export { createSeededRng, deriveDomainSeed } from './rng.js';
export type { SeededRng } from './rng.js';

export { createSimulatedClock, birthDateForAge } from './clock.js';
export type { SimulatedClock } from './clock.js';

export {
  sourceRegisterV1,
  givenNamePool,
  familyNamePool,
  affirmedNamePool,
  stateGeographyV1,
  legacySourceSystems,
  conditionCatalog,
  medicationCatalog,
  encounterClasses,
} from './vocab.js';
export type { CorpusSourceRegisterRow, SourceAcquisitionState, StateGeography } from './vocab.js';

export { assertObservedAttributeNames, importSyntheaExport } from './synthea.js';
export type {
  ClinicalBackboneEntry,
  ImportQuarantineRecord,
  QuarantineReason,
  SyntheaConditionRow,
  SyntheaEncounterRow,
  SyntheaExport,
  SyntheaImportResult,
  SyntheaMedicationRow,
  SyntheaPatientRow,
  SyntheaRunRequest,
  SyntheaRunnerPort,
} from './synthea.js';

export { generateIdentityWorld, overlapIsMergeSufficient } from './identity.js';
export type {
  CollisionTruth,
  CorpusEndpoint,
  CorpusHousehold,
  CorpusName,
  CorpusSourceIdentifier,
  CorpusSubject,
  IdentityCollision,
  IdentityWorld,
  IdentityWorldSpec,
} from './identity.js';

export { evaluatePersonaStoryCoverage, personaStoryCoverageErrors } from './coverage.js';
export type { CoverageSubject, PersonaStoryCoverageReport } from './coverage.js';

export {
  RecoveryEpochFenceError,
  assertReplayFenced,
  buildCorpusSideEffect,
  corpusEffectIdempotencyKey,
  duplicateSideEffectsOnReplay,
  manifestRecoveryEpoch,
  planCorpusReplay,
} from './epoch.js';
export type {
  CorpusEffectKind,
  CorpusReplayPlan,
  CorpusSideEffect,
  ReplayLedgerEntry,
} from './epoch.js';

export {
  assertCorpusBootWatermark,
  assertCorpusRecordsWatermarked,
  generateSynthCorpus,
  loadSynthCorpus,
  parseSynthCorpus,
  serializeSynthCorpus,
  synthgenProfileV1,
} from './corpus.js';
export type {
  CorpusLocationSpec,
  CorpusPersonaAssignment,
  SynthCorpus,
  SynthCorpusSpec,
} from './corpus.js';

export {
  renderSynthgenSeedSection,
  synthgenSeedBeginMarker,
  synthgenSeedEndMarker,
} from './emit-sql.js';
