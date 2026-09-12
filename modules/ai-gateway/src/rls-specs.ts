import type { RlsTableSpec } from '@practicehub/platform-core';

export const aiGatewayRlsSpecs: readonly RlsTableSpec[] = [
  { schema: 'ai_gateway', table: 'model_binding', kind: 'tenant-scoped' },
  { schema: 'ai_gateway', table: 'tool_grant', kind: 'tenant-scoped' },
  { schema: 'ai_gateway', table: 'cohort_containment', kind: 'tenant-scoped' },
  { schema: 'ai_gateway', table: 'interaction', kind: 'tenant-scoped' },
];

export const aiGatewaySchemaRlsSpecs: readonly RlsTableSpec[] = [...aiGatewayRlsSpecs];
