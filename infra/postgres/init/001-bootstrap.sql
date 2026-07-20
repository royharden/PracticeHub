CREATE SCHEMA IF NOT EXISTS platform_core;

CREATE TABLE IF NOT EXISTS platform_core.synthetic_tenant (
  tenant_id text PRIMARY KEY,
  display_name text NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  bootstrap_capability_state text NOT NULL
    CHECK (bootstrap_capability_state IN ('disabled', 'simulated'))
);
