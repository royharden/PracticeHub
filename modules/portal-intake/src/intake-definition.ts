import {
  IntakeError,
  preRegistrationFieldKeys,
  type IntakeDefinition,
  type PreRegistrationFieldKey,
} from './intake-types.js';

const allowed = new Set<string>(preRegistrationFieldKeys);

export function validateIntakeDefinition(definition: IntakeDefinition): void {
  if (definition.fields.length === 0)
    throw new IntakeError('intake definition must declare fields');
  const seen = new Set<string>();
  for (const field of definition.fields) {
    if (!allowed.has(field.key))
      throw new IntakeError(`unknown pre-registration field ${field.key}`);
    if (seen.has(field.key)) throw new IntakeError(`duplicate intake field ${field.key}`);
    if (!field.purpose.trim() || !field.retentionRule.trim()) {
      throw new IntakeError(`field ${field.key} requires purpose and retention rule`);
    }
    seen.add(field.key);
  }
  const healthKeys = new Set<string>();
  for (const field of definition.healthFields) {
    if (!/^[a-z0-9][a-z0-9:._-]{0,127}$/.test(field.key))
      throw new IntakeError(`invalid health field ${field.key}`);
    if (healthKeys.has(field.key)) throw new IntakeError(`duplicate health field ${field.key}`);
    if (
      !field.purpose.trim() ||
      !field.retentionRule.trim() ||
      field.sensitivity !== 'health' ||
      field.collectionConsentPurpose !== 'quiz-collection'
    )
      throw new IntakeError(`health field ${field.key} lacks collection metadata`);
    healthKeys.add(field.key);
  }
}

export function validateSubmittedFields(
  definition: IntakeDefinition,
  fields: Readonly<Record<string, string>>,
): Readonly<Partial<Record<PreRegistrationFieldKey, string>>> {
  validateIntakeDefinition(definition);
  const defined = new Map(definition.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key) || !defined.has(key as PreRegistrationFieldKey)) {
      throw new IntakeError(`unlisted pre-registration field ${key} is refused`);
    }
  }
  for (const field of definition.fields) {
    if (field.required && !fields[field.key]?.trim()) {
      throw new IntakeError(`required field ${field.key} is missing`);
    }
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim())) as Readonly<
    Partial<Record<PreRegistrationFieldKey, string>>
  >;
}

export function validateHealthAnswers(
  definition: IntakeDefinition,
  answers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  validateIntakeDefinition(definition);
  const declared = new Set(definition.healthFields.map((field) => field.key));
  for (const [key, value] of Object.entries(answers)) {
    if (!declared.has(key)) throw new IntakeError(`undeclared health field ${key} is refused`);
    if (!value.trim()) throw new IntakeError(`health field ${key} cannot be blank`);
  }
  return { ...answers };
}
