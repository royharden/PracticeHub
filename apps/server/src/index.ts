export interface ServerWiring {
  readonly name: 'practicehub-server';
  readonly mode: 'synthetic-local';
}

export const serverWiring: ServerWiring = {
  name: 'practicehub-server',
  mode: 'synthetic-local',
};
