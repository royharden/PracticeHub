-- UNAPPLIED. WP-062 encounters/notes/med-list. Do not migrate from this package.
-- Named 0042-encounters.sql per assignments/D20-WP-062-paths.md.
CREATE TABLE IF NOT EXISTS encounters.encounter (
  tenant_id text NOT NULL,
  person_id text NOT NULL,
  encounter_id text NOT NULL,
  PRIMARY KEY (tenant_id, encounter_id)
);
CREATE TABLE IF NOT EXISTS encounters.clinical_note (
  tenant_id text NOT NULL,
  person_id text NOT NULL,
  encounter_id text NOT NULL,
  note_id text NOT NULL,
  state text NOT NULL,
  version integer NOT NULL,
  signed_base_version integer,
  soap_subjective text NOT NULL,
  soap_objective text NOT NULL,
  soap_assessment text NOT NULL,
  soap_plan text NOT NULL,
  amendment_reason text,
  assigned_signer_ref text,
  attestation_ref text,
  PRIMARY KEY (tenant_id, note_id)
);
CREATE TABLE IF NOT EXISTS encounters.med_list_owner (
  tenant_id text NOT NULL,
  person_id text NOT NULL,
  owner_ref text NOT NULL,
  PRIMARY KEY (tenant_id, person_id)
);
