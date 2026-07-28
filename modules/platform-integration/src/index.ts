// WP-026 (M07): adapter framework + VendorRegistry + PHI-class/vendor-BAA egress guards.
export * from './vendor-registry.js';
export * from './egress-guard.js';
export * from './content-license.js';
export * from './adapters.js';
export * from './rls-specs.js';
export * from './seed-data.js';
export * from './commands/register-vendor-baa.command.js';
// WP-027 (M07): the rail-simulator control port + its gated injection command.
export * from './rail-simulator.js';
export * from './commands/inject-rail-scenario.command.js';
