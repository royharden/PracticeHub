// openLead and openIdentitySplit are internal (hardening H-25 R2): they carry no
// identity or tenant check. The public entry points are openLeadForIdentity and
// openGovernedIdentitySplit below.
export {
  advanceLead,
  CrmError,
  mergeSilently,
  projectDerivedFlag,
  writeDerivedFlagOntoIdentity,
} from './crm.js';
export type {
  DerivedFlag,
  IdentitySplit,
  Lead,
  Member360Purpose,
  MemberRecord,
  PipelineStage,
} from './crm.js';
export { DerivedFlagProjection } from './derived-flags.js';
export type { MembershipValueFact, StoredDerivedFlag } from './derived-flags.js';
export {
  linkSplitToMergeCase,
  openGovernedIdentitySplit,
  openLeadForIdentity,
  resolveIdentitySplit,
} from './identity-split.js';
export type { GovernedIdentitySplit, IdentitySplitStatus } from './identity-split.js';
export { member360ForCaller } from './member360.js';
export type { ScopedMember360View } from './member360.js';
export { RecordingIdentityPort, StaticMember360Pdp } from './ports.js';
export type {
  CrmCaller,
  IdentityReadPort,
  IdentitySnapshot,
  Wp015PdpPort,
  Wp016MergeCasePort,
} from './ports.js';
