import { REHEARSAL_PANEL_SIZE, RehearsalError, requireSynthetic } from './types.js';
import type { RehearsalPanel, RehearsalSubject } from './types.js';

export function boundedPanel(input: {
  readonly tenantId: string;
  readonly panelId: string;
  readonly subjects: readonly RehearsalSubject[];
  readonly synthetic: boolean;
}): RehearsalPanel {
  requireSynthetic(input.synthetic);
  if (input.tenantId.trim() === '' || input.panelId.trim() === '') {
    throw new RehearsalError('tenantId and panelId are required');
  }
  if (input.subjects.length !== REHEARSAL_PANEL_SIZE) {
    throw new RehearsalError(
      `rehearsal panel must be exactly ${REHEARSAL_PANEL_SIZE} synthetic subjects`,
    );
  }
  if (!input.subjects.every((subject) => subject.synthetic === true)) {
    throw new RehearsalError('every rehearsal subject must be synthetic');
  }
  const refs = new Set(input.subjects.map((subject) => subject.subjectRef));
  if (refs.size !== REHEARSAL_PANEL_SIZE) {
    throw new RehearsalError('rehearsal panel subjects must be unique');
  }
  return {
    tenantId: input.tenantId,
    panelId: input.panelId,
    subjects: input.subjects,
    synthetic: true,
  };
}

export function twentySyntheticSubjects(prefix = 'acq'): readonly RehearsalSubject[] {
  return Array.from({ length: REHEARSAL_PANEL_SIZE }, (_, index) => ({
    subjectRef: `${prefix}-${String(index + 1).padStart(2, '0')}`,
    synthetic: true as const,
  }));
}
