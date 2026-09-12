import { apiOrigin } from './api-doubles.js';
import { createJourneyContract } from './contract.js';

export const clinicalCoexistenceContract = createJourneyContract({
  key: 'wp032',
  id: 'wp032-clinical-coexistence-page/v1',
  title: 'Clinical coexistence reconciliation',
  actionKind: 'acknowledge-clinical-version',
  localizedTitle: {
    en: 'Clinical coexistence reconciliation',
    es: 'Conciliación de coexistencia clínica',
  },
  localizedActionLabel: {
    en: 'Acknowledge synthetic reconciliation',
    es: 'Confirmar conciliación sintética',
  },
  endpoint: apiOrigin + '/api/v1/wp032/clinical-coexistence',
  createAction: (note) => ({
    kind: 'acknowledge-clinical-version',
    note,
    clinicalVersion: 'v1-reconciled',
    clinicianAcknowledged: true,
  }),
});
