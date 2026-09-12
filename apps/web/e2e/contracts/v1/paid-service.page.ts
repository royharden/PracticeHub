import { apiOrigin } from './api-doubles.js';
import { createJourneyContract } from './contract.js';

export const paidServiceContract = createJourneyContract({
  key: 'wp031',
  id: 'wp031-paid-service-page/v1',
  title: 'Paid service confirmation',
  actionKind: 'confirm-paid-service',
  localizedTitle: {
    en: 'Paid service confirmation',
    es: 'Confirmación del servicio pagado',
  },
  localizedActionLabel: {
    en: 'Confirm synthetic paid service',
    es: 'Confirmar servicio pagado sintético',
  },
  endpoint: apiOrigin + '/api/v1/wp031/paid-service',
  createAction: (note) => ({
    kind: 'confirm-paid-service',
    note,
    orderState: 'paid',
    entitlementState: 'active',
  }),
});
