import { apiOrigin } from './api-doubles.js';
import { createJourneyContract } from './contract.js';

export const accountableMessageContract = createJourneyContract({
  key: 'wp030',
  id: 'wp030-accountable-message-page/v1',
  title: 'Accountable message handoff',
  actionKind: 'accept-accountable-owner',
  localizedTitle: {
    en: 'Accountable message handoff',
    es: 'Entrega responsable del mensaje',
  },
  localizedActionLabel: {
    en: 'Accept accountable handoff',
    es: 'Aceptar entrega responsable',
  },
  endpoint: apiOrigin + '/api/v1/wp030/accountable-message',
  createAction: (note) => ({ kind: 'accept-accountable-owner', note, ownerAccepted: true }),
});
