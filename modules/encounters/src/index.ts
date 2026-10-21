export { EncounterNoteService, EncounterNoteError } from './note-lifecycle.js';
export type { EncounterNote, NoteEvent } from './note-lifecycle.js';
export { MedicationList, MedListError } from './med-list.js';
export { ResultsReleaseService, ResultsReleaseError, exceptionCodes } from './results-release.js';
export type {
  ExceptionCode,
  HeldResult,
  InfoBlockingException,
  PatientResultView,
  ReleasePolicy,
  ResultEvent,
  ResultScope,
} from './results-release.js';
export { RecordsRequestDesk, RecordsRequestError } from './records-request.js';
export type {
  RecordsRequestIntake,
  RecordsRequestWorkItem,
  WorklistEntry,
} from './records-request.js';
export { recordsClosureFloor, resolveClosurePolicy } from './records-clock.double.js';
export type { ClockStatus, RecordsClosurePolicy } from './records-clock.double.js';
export { DowntimeKit, DowntimeError, paperForms, runDowntimeDrill } from './downtime.js';
export type {
  DrillReport,
  DrillStep,
  DowntimeMode,
  Outage,
  PaperCapture,
  PaperForm,
  SnapshotRecord,
} from './downtime.js';
export * from './hti1/index.js';
export type {
  AthenaAttestation,
  ClinicalScope,
  NoteState,
  SoapBody,
} from './clinical-contracts.double.js';
