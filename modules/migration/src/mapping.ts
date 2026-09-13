import type { MappingRule, MappingVersion, SourceManifest } from './types.js';

export class MigrationMappingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MigrationMappingError';
  }
}

const hashPattern = /^[0-9a-f]{64}$/;
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;

function requireRef(value: string, field: string): void {
  if (!refPattern.test(value)) {
    throw new MigrationMappingError(`${field} must be a constrained reference`);
  }
}

function validateRule(rule: MappingRule): void {
  requireRef(rule.sourceField, 'sourceField');
  if (!['mapped', 'unmapped', 'excluded-with-reason'].includes(rule.disposition)) {
    throw new MigrationMappingError(`${rule.sourceField} has an unknown disposition`);
  }
  if (!['none', 'demographic', 'phi', 'phi-restricted'].includes(rule.dataClassification)) {
    throw new MigrationMappingError(`${rule.sourceField} has an unknown data classification`);
  }
  if (rule.disposition === 'mapped') {
    if (rule.targetField === undefined) {
      throw new MigrationMappingError(`${rule.sourceField} is mapped without targetField`);
    }
    requireRef(rule.targetField, 'targetField');
    if (rule.exclusionReasonRef !== undefined) {
      throw new MigrationMappingError(
        `${rule.sourceField} is mapped but carries exclusionReasonRef`,
      );
    }
  } else if (rule.targetField !== undefined) {
    throw new MigrationMappingError(`${rule.sourceField} is not mapped but carries targetField`);
  }

  if (rule.disposition === 'excluded-with-reason') {
    if (rule.exclusionReasonRef === undefined) {
      throw new MigrationMappingError(`${rule.sourceField} is excluded without a reason`);
    }
    requireRef(rule.exclusionReasonRef, 'exclusionReasonRef');
  } else if (rule.exclusionReasonRef !== undefined) {
    throw new MigrationMappingError(`${rule.sourceField} carries an unexpected exclusion reason`);
  }
}

export function validateMappingForManifest(
  mapping: MappingVersion,
  manifest: SourceManifest,
): void {
  if (mapping.synthetic !== true || manifest.synthetic !== true) {
    throw new MigrationMappingError('mapping and manifest must carry the synthetic watermark');
  }
  requireRef(mapping.tenantId, 'mapping tenantId');
  requireRef(manifest.tenantId, 'manifest tenantId');
  requireRef(mapping.sourceSystemRef, 'mapping sourceSystemRef');
  requireRef(manifest.sourceSystemRef, 'manifest sourceSystemRef');
  requireRef(mapping.mappingVersionRef, 'mappingVersionRef');
  requireRef(manifest.sourceManifestRef, 'sourceManifestRef');
  if (mapping.tenantId !== manifest.tenantId) {
    throw new MigrationMappingError('mapping and manifest tenants differ');
  }
  if (mapping.sourceSystemRef !== manifest.sourceSystemRef) {
    throw new MigrationMappingError(
      'a mapping approved for another source cannot become authoritative',
    );
  }
  if (
    mapping.status !== 'approved' ||
    mapping.approvedBy === undefined ||
    mapping.approvalEvidenceRef === undefined
  ) {
    throw new MigrationMappingError('mapping requires source-specific approval evidence');
  }
  if (
    !hashPattern.test(mapping.mappingVersionHash) ||
    !hashPattern.test(manifest.sourceManifestHash)
  ) {
    throw new MigrationMappingError('manifest and mapping hashes must be sha-256');
  }

  const rules = new Map<string, MappingRule>();
  for (const rule of mapping.rules) {
    validateRule(rule);
    if (rules.has(rule.sourceField)) {
      throw new MigrationMappingError(
        `source field ${rule.sourceField} is classified more than once`,
      );
    }
    rules.set(rule.sourceField, rule);
  }
  if (new Set(manifest.sourceFields).size !== manifest.sourceFields.length) {
    throw new MigrationMappingError('source manifest contains duplicate field identities');
  }
  for (const sourceField of manifest.sourceFields) {
    if (!rules.has(sourceField)) {
      throw new MigrationMappingError(`source field ${sourceField} has no explicit disposition`);
    }
  }
  for (const sourceField of rules.keys()) {
    if (!manifest.sourceFields.includes(sourceField)) {
      throw new MigrationMappingError(`mapping contains stale source field ${sourceField}`);
    }
  }
}

export function cloneTemplateForSource(
  template: MappingVersion,
  tenantId: string,
  sourceSystemRef: string,
  mappingVersionRef: string,
  mappingVersionHash: string,
): MappingVersion {
  return {
    tenantId,
    sourceSystemRef,
    mappingVersionRef,
    mappingVersionHash,
    status: 'review-required',
    rules: template.rules.map((rule) => ({ ...rule })),
    synthetic: true,
  };
}
