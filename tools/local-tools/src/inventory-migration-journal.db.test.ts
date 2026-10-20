/**
 * PRIVATE SOURCE PROPOSAL — 0294 / D80 / PH-R02 T6. ALL EXECUTION UNRUN.
 * Canonical application and physical activation are separate grants.
 * Execution requires the separately reviewed exact physical/effect binding below.
 * No default target, provisioning, reset, retry, skip or fixture fallback exists.
 * These authored assertions and their counterexamples have never been executed.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  admitTestClusters,
  bindTestDatabase,
  buildMigrationScript,
  createDockerMigrationTransport,
  discoverMigrations,
  Migration,
  runMigrationsAsync,
  testDatabaseArguments,
  validateMigrationTarget,
  validateTestTarget,
} from './migrations.js';
import type {
  BoundDatabase,
  ExecutionResult,
  MigrationExecutionOptions,
  MigrationTarget,
  MigrationTransport,
  TestTarget,
} from './migrations.js';
import { localDockerSelection } from './compose-config.js';
import type { LocalDockerBinding } from './compose-config.js';
import type { WindowsSupervisorBinding } from './migration-supervisor.js';

const originalPath = 'modules/inventory/migrations/0066-wp075-inventory.sql';
const originalHash = '7bf23488a15f877bc9489a0e1733747cb28921d8c355fa0b3c09879d99c24ad1';
const eventPath = 'modules/inventory/migrations/0074-inventory-recall-events.sql';
const eventHash = '3ab57dd953104cb19eeb9045c5f97fb0fa3605979ec007fc5fe97b0d316f566e';
const inverseHash = '05299a40922c9d25320b3e6355bbd131da6369d356b819ff97dc9fc631398457';
const tenants = ['northwind-synthetic', 'riverbend-synthetic'] as const;
const inventoryTables = [
  'product',
  'lot',
  'unit',
  'dispense',
  'dispense_unit',
  'recall_unit',
] as const;
const labsTables = [
  'lab_order',
  'lab_result',
  'critical_closure',
  'expected_result_age',
  'device_calibration',
  'device_recall',
] as const;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
};
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function requireProof(ok: unknown, label: string): asserts ok {
  if (!ok) throw new Error(`MIX assertion: ${label}`);
}

// Literal file pins copied from the authorized current-input manifest. No SQL
// source rewriting or historical fixture module import is involved.
const forwardPins: readonly { path: string; sha256: string; bytes: number }[] = [
  {
    path: 'modules/platform-core/migrations/0001-tenancy.sql',
    sha256: '72645c4c814107fe2159e3eed91ecdc7085acbc64f40b35f90b376d1be124145',
    bytes: 8357,
  },
  {
    path: 'modules/platform-core/migrations/0002-jurisdiction.sql',
    sha256: '6e0aa368f9549faa2ac9a4ca1c2b548b7d0a22ccc6026bcfa0194c57c914c05f',
    bytes: 6969,
  },
  {
    path: 'modules/platform-core/migrations/0003-capability.sql',
    sha256: '532754d7fbffddb4afbde2312f41188af9e62d602d97cbe9cd18a4b70008ff39',
    bytes: 6691,
  },
  {
    path: 'modules/identity/migrations/0004-identity.sql',
    sha256: '676cf08c775a30d96fa794b85656a577950930b9067253b4a10dff7d34115d9b',
    bytes: 20386,
  },
  {
    path: 'modules/identity/migrations/0005-authn.sql',
    sha256: 'bfd3fb713068886ec26a444ecef74c672e95f8d799875f4e03f94a2642fdb560',
    bytes: 14489,
  },
  {
    path: 'modules/identity/migrations/0006-merge.sql',
    sha256: 'fdce411707c1ad171085b68facfa1e8657ad07d704b17acc4aadb58004604024',
    bytes: 12604,
  },
  {
    path: 'modules/audit-evidence/migrations/0007-audit.sql',
    sha256: 'a7ed7ad042367ff4f93ba8c45d8dc1332b7fd93e5437dab965f799e67d3cc86d',
    bytes: 12693,
  },
  {
    path: 'modules/identity/migrations/0008-pdp.sql',
    sha256: '4767b9fce64b89ba7dc112c4419de541675a6ec91555ee74c35272bc13afbac6',
    bytes: 16402,
  },
  {
    path: 'modules/consent/migrations/0009-consent.sql',
    sha256: '35287bdb0f5368ff2654ec55285bdb2f99806fa2e6bfcb90f3120260eb4e9016',
    bytes: 10100,
  },
  {
    path: 'modules/events/migrations/0010-events.sql',
    sha256: '29c84d0663c8b72316280c2038d679f845b3a1e5944a559efc4f174a74a4702a',
    bytes: 9456,
  },
  {
    path: 'modules/consent/migrations/0011-policy-clocks.sql',
    sha256: '0f62eee59ee16d4fa272aeb49f481e26019f29b90ff03ed2376f414dfcc0db00',
    bytes: 18245,
  },
  {
    path: 'modules/events/migrations/0012-workitems.sql',
    sha256: 'f49e9697ddcc448f3da8b8dc0d479948f6e9a720c523e21397a5a854b776581b',
    bytes: 13550,
  },
  {
    path: 'modules/identity/migrations/0013-elevation.sql',
    sha256: 'de112a9637069255f987b2b5271da3880c82688c29ccada86bf15b79210cb99e',
    bytes: 15863,
  },
  {
    path: 'modules/events/migrations/0014-oncall.sql',
    sha256: 'cbc814d72bb2407e48a4047c6fc44eec10f300b54fa384291f508436c8673e76',
    bytes: 11384,
  },
  {
    path: 'modules/documents/migrations/0015-documents.sql',
    sha256: '9b6490d4dee619674eb5e45ddea5a7e7d0c12b02a8bdc21630860f74e74bf38c',
    bytes: 11635,
  },
  {
    path: 'modules/documents/migrations/0016-documents-records.sql',
    sha256: 'feab8b158ab0d0fe6dfef07497b59622e921865f46e62ef6b9dd8c561d989d05',
    bytes: 12379,
  },
  {
    path: 'modules/platform-integration/migrations/0017-vendor-registry.sql',
    sha256: '3d28f32d91ac0bc571978b108a17fc35e101a89e146cec8fbd7ecac2edb94d42',
    bytes: 12315,
  },
  {
    path: 'modules/comms/migrations/0018-thread.sql',
    sha256: '0bae58aeef28e8e115b0b315fb9b76c2cac751b87e12fe9e253db9d0a7102894',
    bytes: 6197,
  },
  {
    path: 'modules/payments-ledger/migrations/0019-cash-ledger.sql',
    sha256: '87035a5d9b27fdc545f6b0e1052ff48ea20da34576346bb909634da13587a49a',
    bytes: 9943,
  },
  {
    path: 'modules/membership-entitlements/migrations/0020-entitlement-ledger.sql',
    sha256: '4d56d1dc6fc48aae7092701bf9f7f0aed682a96da5516dbcc3a8f6ca9a4c1e95',
    bytes: 4865,
  },
  {
    path: 'modules/payments-ledger/migrations/0021-ledger-v2.sql',
    sha256: 'dacade4469c78d5dfd5a0fa08c23a430ada4be349e1f90b56f5ed22fdbdf5f49',
    bytes: 4240,
  },
  {
    path: 'modules/catalog-cash/migrations/0021-paid-service.sql',
    sha256: '1dbaffa1d65fcda1bd93037de61ead6ab3a01108db147cf80c80e7ffdb8c5e84',
    bytes: 7483,
  },
  {
    path: 'modules/payments-ledger/migrations/0022-statements.sql',
    sha256: 'd6f807710e73b55633292a9710f96b8d1701bfaf68ba8a4273d300c63e92af8c',
    bytes: 3879,
  },
  {
    path: 'modules/ai-gateway/migrations/0023-ai-gateway.sql',
    sha256: 'c11aa9261b54edd63874895bcf4d877310ef506ea6c57bc75b7ab089a5057afd',
    bytes: 8822,
  },
  {
    path: 'modules/portal-intake/migrations/0024-portal-intake.sql',
    sha256: 'c9a436dda10a5c77c0dd62530716df80f1bdf18d7d05169c775dc106349d8078',
    bytes: 17208,
  },
  {
    path: 'modules/analytics/migrations/0026-analytics.sql',
    sha256: 'eb504fe7f2ededbc17b2728748131e6448a3b71db23886602c3560819265603d',
    bytes: 10932,
  },
  {
    path: 'modules/migration/migrations/0027-migration.sql',
    sha256: '7e0887b50c7a8f05422c511e9f057bf0f0c7aaeb1b69568d9b5e280dabad9f17',
    bytes: 24050,
  },
  {
    path: 'modules/events/migrations/0028-event-delivery-parks.sql',
    sha256: 'a058776ea0eca1962d691885824ff7f0c1df867814016623a9b6af0a62f44638',
    bytes: 991,
  },
  {
    path: 'modules/breach-case/migrations/0030-breach-case.sql',
    sha256: '868db3c5176c7a7b0fa7760e25085b4eb7676ccdfc7d55c058f14d524c0d2e41',
    bytes: 20397,
  },
  {
    path: 'modules/clinical-contracts/migrations/0036-clinical-contracts.sql',
    sha256: '3f64dbf43fdb5e2b9767176fb4c2b44a8311c57392d7c31926096941d1990d16',
    bytes: 318,
  },
  {
    path: 'modules/catalog/migrations/0037-catalog.sql',
    sha256: 'd7665f144098c00f2f0c0b04501c18fc75905fb4786a9f599d1434906dfa77ca',
    bytes: 5653,
  },
  {
    path: 'modules/membership/migrations/0038-membership.sql',
    sha256: 'b16541302678292d27b78b756e74d44967f03e121f2d499362547c1d82c90d79',
    bytes: 4337,
  },
  {
    path: 'modules/entitlements/migrations/0041-entitlements.sql',
    sha256: '916ce7f82b0e68bbfac2968858008934d5d8f59a74488bdd3f348d5b0cf1b484',
    bytes: 1776,
  },
  {
    path: 'modules/athena-cutover/migrations/0046-athena-cutover.sql',
    sha256: '042078c2caccf04d17a28fc164402cb52c218fb644ab974d36ddfd31b1907a01',
    bytes: 149,
  },
  {
    path: 'modules/vintage-import/migrations/0047-vintage-import.sql',
    sha256: '1d863eaade8570fe8cf70f28a3d7c3ca08fed70da45f1b31d36a038022d99be7',
    bytes: 4333,
  },
  {
    path: 'modules/acquisition-rehearsal/migrations/0049-acquisition-rehearsal.sql',
    sha256: 'bb447d26e22780d076353d8a490f08d1b0e95b7354336c531ad23fc6e8b5ec26',
    bytes: 2293,
  },
  {
    path: 'modules/tenant-white-label/migrations/0056-tenant-white-label.sql',
    sha256: '10a871d15453bd10130981bf30a2cbb74e6824f2f0a0c34d0c5a09ded76a6a70',
    bytes: 2031,
  },
  {
    path: 'modules/catalog/migrations/0061-wp051-catalog-gfe.sql',
    sha256: '355eb2aaf93109e66e67545ffa407d47bd3d161d1d0cabbe697e91bb566b93bc',
    bytes: 5403,
  },
  {
    path: 'modules/labs/migrations/0064-labs.sql',
    sha256: '4f5272e014052c457128cfd557e2555f469c5f8e31dc1d1f51a562d759ecbd6e',
    bytes: 8382,
  },
  {
    path: 'modules/labs/migrations/0065-labs-device.sql',
    sha256: '0e3f9c2584ca27795f98c4ef5c0716f08e37ed029182bf1e1b9b6d01add8c48a',
    bytes: 3083,
  },
  {
    path: 'modules/inventory/migrations/0066-wp075-inventory.sql',
    sha256: '7bf23488a15f877bc9489a0e1733747cb28921d8c355fa0b3c09879d99c24ad1',
    bytes: 6433,
  },
  {
    path: 'modules/reviews/migrations/0067-wp073-reviews.sql',
    sha256: '2640aeae0cd3423599e40d96c97b641e493eb0e75147b6e8fc5d8326b61bddc3',
    bytes: 4262,
  },
  {
    path: 'modules/payments-ledger/migrations/0068-ledger-v2-governance.sql',
    sha256: '01a3464a7d6a57d76a9ed9e79f81bfee7f914f6880b999e54124ae04cad568df',
    bytes: 7146,
  },
  {
    path: 'modules/payments-ledger/migrations/0069-dunning-deceased-stop.sql',
    sha256: 'a3e3e9c07ec171ca5def0225ef62f6a90e3ee34e115886f445d9e93655bf3658',
    bytes: 3193,
  },
  {
    path: 'modules/payments-ledger/migrations/0070-oig-exception-report.sql',
    sha256: '13afa474ee8fa2733de3a0573dc1958478f2ba3ffbbc9405d99bde1b9abc7a28',
    bytes: 2398,
  },
  {
    path: 'modules/payments-ledger/migrations/0071-write-off-open-receivable.sql',
    sha256: '5b932edd12355f12d97721b38dbc9a04e69b71c16d013290e7a803148335b814',
    bytes: 2609,
  },
  {
    path: 'modules/payments-ledger/migrations/0072-ledger-rls-coverage.sql',
    sha256: '720ad4d06d92706ee017a8217ccdd8f954cfd6d6c9114fbefa5e0ff48c46c527',
    bytes: 1810,
  },
  {
    path: 'modules/labs/migrations/0073-labs-hardening.sql',
    sha256: 'f3b1cdc354d6af628e437420901c2903ffdffc3885831d33c9c4bebbf5c01a95',
    bytes: 35596,
  },
  {
    path: 'modules/inventory/migrations/0074-inventory-recall-events.sql',
    sha256: '3ab57dd953104cb19eeb9045c5f97fb0fa3605979ec007fc5fe97b0d316f566e',
    bytes: 9523,
  },
];

interface CaseContext {
  readonly target: MigrationTarget;
  readonly admission: TestTarget;
  readonly transport: MigrationTransport;
  readonly options: MigrationExecutionOptions;
  readonly forward: readonly Migration[];
  readonly inverse: Buffer;
  readonly artifactRoot: string;
  readonly artifactRoots: readonly string[];
  readonly observedTarget: TargetWitness;
  effectCalls: number;
}
const supportPins: readonly { path: string; sha256: string; bytes: number }[] = [
  {
    path: 'tools/local-tools/src/migrations.ts',
    sha256: 'de07847c7ae3033d6272599a85b19cff48934dcef4bcc9bd69ab5eb061f3b94c',
    bytes: 48275,
  },
  {
    path: 'tools/local-tools/src/migrations.db.test.ts',
    sha256: '687e304568de420ca581426ee98ff282d57fe5861761c42a325749beaeb49b57',
    bytes: 26270,
  },
  {
    path: 'tools/local-tools/src/migrations.test.ts',
    sha256: '81adeae8eeb619c4f50095d0f1cc0665d9025e5feac6a67bbeda56e802feee8e',
    bytes: 29549,
  },
  {
    path: 'tools/local-tools/src/migration-supervisor.ts',
    sha256: '379f8c88d3c5fc8e9ef1ded37b2e60c4e79c87de436944ba3b18e306225b33ec',
    bytes: 19551,
  },
  {
    path: 'tools/local-tools/src/compose-config.ts',
    sha256: '96c810f4bc8f216be38bc79220d0ecca0eae28d5c83479190dfd090cfd287684',
    bytes: 15968,
  },
  {
    path: 'tools/local-tools/package.json',
    sha256: '97a25e2c0236c4e1ab21b51c520eaafe3a46b1629f686039f7a34b7d3d1f9f8e',
    bytes: 781,
  },
  {
    path: 'tools/local-tools/tsconfig.json',
    sha256: '6edcf9a08c115a4a176716d91711359e78ebb4da437fdbf0d576b1285a5e278e',
    bytes: 209,
  },
  {
    path: 'tools/local-tools/vitest.config.ts',
    sha256: '1a13cf3ffd9a2554a8d4ccdf21795828f446d944b60bfc446ac1db2a2131254f',
    bytes: 172,
  },
  {
    path: 'tools/local-tools/vitest.db.config.ts',
    sha256: 'dba3aea860dd8fc6dc6b65c9869f29f762261a89e260dcadb49c3d06db57a037',
    bytes: 230,
  },
  {
    path: 'modules/inventory/contracts/inventory-api.md',
    sha256: 'dd909217ff007341b25b60d64f3ccb0d3a009142bdf01956e41f69561b8f1264',
    bytes: 2900,
  },
  {
    path: 'modules/inventory/src/db-test-harness.ts',
    sha256: 'dcc63a8bc5b8cf093c5c4a13effdf4df035827c1094e92444b7e5721b1d0ee5e',
    bytes: 36907,
  },
  {
    path: 'modules/inventory/src/inventory-migrations.db.test.ts',
    sha256: 'c01a75f76a09991e0ad7b3a33113ea62a7fa1e8411981541fab5424800144244',
    bytes: 52921,
  },
  {
    path: 'modules/inventory/src/inventory-migration-proof.test.ts',
    sha256: 'df0a692e3e003d4e8cc71e59fbc36e1209a21b48714a108b8ebd29ee9c0f5579',
    bytes: 28834,
  },
  {
    path: 'modules/inventory/migrations/0066-wp075-inventory.rollback.sql',
    sha256: 'ffe6017231099b529c468f7939137ee4a40b0eecf2901773273c57f23d75de3d',
    bytes: 323,
  },
  {
    path: 'modules/inventory/migrations/0074-inventory-recall-events.rollback.sql',
    sha256: '05299a40922c9d25320b3e6355bbd131da6369d356b819ff97dc9fc631398457',
    bytes: 2106,
  },
  {
    path: 'modules/labs/contracts/lab-api.md',
    sha256: '6144ff81e28bd0980b4969e1542cccb05c8d6eba0762c2d321a2637aa5787ca1',
    bytes: 7181,
  },
  {
    path: 'modules/labs/src/db-test-harness.ts',
    sha256: '48ba01dcc6890d404a7ce90c51d8697e89a56273d4d25726b1de47b4f01bc0df',
    bytes: 11089,
  },
  {
    path: 'modules/labs/src/labs-migrations.db.test.ts',
    sha256: '2bb38aaf58e9682129869e13d1cdce593b000db15f3bd603334e46ca416c6650',
    bytes: 31260,
  },
  {
    path: 'modules/payments-ledger/contracts/ledger-api-v2.md',
    sha256: 'd7ff1494c65e01f9dc9c8155a98a5bcd2d38f06f1e2f2dda9ac4a4c186c15685',
    bytes: 5204,
  },
  {
    path: 'modules/payments-ledger/src/migration-proof.db.test.ts',
    sha256: '5f83a5182bf96117598008a5c69aa17e26ebd9b82d9cb08ffd69ee2487136f6d',
    bytes: 32061,
  },
  {
    path: 'infra/postgres/init/001-bootstrap.sql',
    sha256: '07b4e0ae1167512c15f5c6828357b84a480de9e305ca4eb3dfe58e52e56010e4',
    bytes: 326,
  },
  {
    path: 'infra/postgres/init/002-seed.sql',
    sha256: 'e624f0b28ed46fc3337c6c15db8f2f014e98e7e2350bc6640259d5a14e087b0d',
    bytes: 455,
  },
  {
    path: 'tools/local-tools/src/lane-observation-context.ts',
    sha256: '71d4291898579ed07d128d7ad9801864ec165d27a7c6e62843ad844647e45f15',
    bytes: 12780,
  },
  {
    path: 'tools/local-tools/src/lane-source-observer.worker.ts',
    sha256: 'b8a4fbce106f3538ee5aec3502efeb6a7057fd28b4816fc4b0af300f65bf3559',
    bytes: 1207,
  },
];
const approvedEffects = [
  'native-owned-observe-and-execute',
  'owned-backend-termination',
  'original-role-creation',
  'mixed-fixture-insert',
  'proof-inverse-tail',
  'transaction-fault-injection',
  'event-file-export-restore',
  'finite-artifact-controls',
] as const;
const caseOrder = [
  'MIX-I1',
  'MIX-I4-inverse',
  'MIX-I3-sql',
  'MIX-I3-journal-insert',
  'MIX-I3-deferred-commit',
  'MIX-I2-inverse-reapply',
  'MIX-I4-restore',
  'MIX-I2-restore-replay',
] as const;
interface RuntimeBinding {
  readonly version: 1;
  readonly grant: string;
  readonly sourceRoot: string;
  readonly candidateSha256: string;
  readonly target: TestTarget;
  readonly database: TargetWitness;
  readonly allocation: {
    readonly exclusive: true;
    readonly unconsumedOriginalRoleOrigin: true;
    readonly preprovisionedBootstrapOnly: true;
    readonly secondary: 'admit-only-no-migration';
    readonly order: readonly string[];
    readonly effects: readonly string[];
    readonly credentialGrant: string;
  };
  readonly artifactRoot: string;
  readonly docker: LocalDockerBinding;
  readonly nativePaths: WindowsSupervisorBinding;
  readonly options: MigrationExecutionOptions;
}
function canonicalPath(path: string, directory: boolean): void {
  requireProof(typeof path === 'string' && resolve(path) === path, 'absolute canonical path');
  let ancestor = path;
  for (;;) {
    const stat = lstatSync(ancestor);
    requireProof(
      !stat.isSymbolicLink() && realpathSync(ancestor) === ancestor,
      'no linked path ancestor',
    );
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const stat = lstatSync(path);
  requireProof(directory ? stat.isDirectory() : stat.isFile(), 'expected filesystem kind');
}
function pinnedBytes(path: string, sha256: string, bytes?: number): Buffer {
  requireProof(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256), 'pinned SHA256 shape');
  canonicalPath(path, false);
  const value = readFileSync(path);
  requireProof(
    hash(value) === sha256 && (bytes === undefined || value.length === bytes),
    'pinned file bytes',
  );
  return value;
}
function readRuntimeBinding(): { binding: RuntimeBinding; bindingHash: string } {
  const path = process.env['PH_INVENTORY_JOURNAL_BINDING'];
  const digest = process.env['PH_INVENTORY_JOURNAL_BINDING_SHA256'];
  requireProof(
    path && digest,
    'explicit pinned inventory journal physical/effect binding required',
  );
  const binding = JSON.parse(pinnedBytes(path, digest).toString('utf8')) as RuntimeBinding;
  requireProof(
    binding && binding.version === 1 && typeof binding.grant === 'string' && binding.grant.trim(),
    'runtime grant/version',
  );
  const target = validateTestTarget(binding.target);
  requireProof(target.grant === binding.grant, 'same exact two-cluster effect grant');
  const a = binding.allocation;
  requireProof(
    a &&
      a.exclusive === true &&
      a.unconsumedOriginalRoleOrigin === true &&
      a.preprovisionedBootstrapOnly === true &&
      a.secondary === 'admit-only-no-migration' &&
      same(a.order, caseOrder) &&
      same(a.effects, approvedEffects) &&
      typeof a.credentialGrant === 'string' &&
      a.credentialGrant.trim(),
    'finite exclusive preprovisioned allocation and exact effects',
  );
  const db = binding.database;
  requireProof(
    db &&
      db.cid === target.containerId &&
      db.sid === target.clusterSystemIdentifier &&
      db.database === `${target.databasePrefix}_mix` &&
      /^[1-9][0-9]*$/.test(db.oid) &&
      db.owner === 'practicehub' &&
      /^[1-9][0-9]*$/.test(db.pgVersion) &&
      db.marker === `PracticeHub inventory journal synthetic: ${db.database}`,
    'complete explicit database tuple/marker',
  );
  const o = binding.options;
  requireProof(
    o &&
      Number.isSafeInteger(o.timeoutMs) &&
      o.timeoutMs > 0 &&
      o.timeoutMs <= 110000 &&
      Number.isSafeInteger(o.cleanupMs) &&
      o.cleanupMs > 0 &&
      o.cleanupMs <= 30000,
    'bounded explicitly granted deadlines',
  );
  canonicalPath(binding.sourceRoot, true);
  canonicalPath(binding.artifactRoot, true);
  const thisFile = fileURLToPath(import.meta.url);
  requireProof(
    thisFile ===
      join(
        binding.sourceRoot,
        'tools',
        'local-tools',
        'src',
        'inventory-migration-journal.db.test.ts',
      ),
    'reviewed candidate applied at exact source target',
  );
  pinnedBytes(thisFile, binding.candidateSha256);
  requireProof(
    readdirSync(binding.artifactRoot).sort().join('|') === 'digest|main|missing|truncated',
    'exact preallocated artifact directories only',
  );
  for (const name of ['main', 'missing', 'truncated', 'digest']) {
    const dir = join(binding.artifactRoot, name);
    canonicalPath(dir, true);
    requireProof(readdirSync(dir).length === 0, `unused artifact allocation ${name}`);
  }
  const n = binding.nativePaths;
  requireProof(n && n.powershellVersion === '7.6.5', 'explicit pinned native supervisor binding');
  pinnedBytes(n.executablePath, n.executableSha256);
  pinnedBytes(n.powershellPath, n.powershellSha256);
  // Existing public-config validator rejects ambient Docker settings, remote
  // endpoints and unmodeled plugin/config files. No CLI/default credential path.
  localDockerSelection(binding.docker);
  for (const pin of supportPins)
    pinnedBytes(join(binding.sourceRoot, pin.path), pin.sha256, pin.bytes);
  requireProof(
    supportPins.length === 24 && forwardPins.length === 49,
    'exact73 source-input membership',
  );
  return { binding: { ...binding, target }, bindingHash: digest };
}
async function assemble(): Promise<{ context: CaseContext; record: () => void }> {
  // All local binding/source rejection occurs before native transport creation.
  const { binding, bindingHash } = readRuntimeBinding();
  const forward = discoverMigrations(binding.sourceRoot);
  requireProof(
    same(
      forward.map((m) => ({ path: m.path, sha256: m.sha256, bytes: m.size })),
      forwardPins,
    ),
    'current discovered ordered49 exact frozen bytes',
  );
  const historical = discoverMigrations(binding.target.headRoot);
  const head = JSON.parse(
    pinnedBytes(
      join(binding.target.headRoot, 'manifest.json'),
      binding.target.headManifestSha256,
    ).toString('utf8'),
  ) as { commit: string; files: { path: string; sha256: string; bytes: number }[] };
  requireProof(
    head.commit === '5a9be52224c93efd95175c3ec5a4ddc0c75ad948' &&
      same(head.files, forwardPins.slice(0, 42)) &&
      same(
        historical.map((m) => ({ path: m.path, sha256: m.sha256, bytes: m.size })),
        forwardPins.slice(0, 42),
      ),
    'complete immutable42 historical prefix',
  );
  const inverse = pinnedBytes(
    join(
      binding.sourceRoot,
      'modules/inventory/migrations/0074-inventory-recall-events.rollback.sql',
    ),
    inverseHash,
  );
  const observations: unknown[] = [];
  const transport = createDockerMigrationTransport({
    nativePaths: binding.nativePaths,
    onObservation: (event) => {
      observations.push(event);
    },
  });
  requireProof(
    transport.bindDocker && transport.command && transport.preflight,
    'existing owned transport capabilities',
  );
  transport.bindDocker(binding.docker);
  const observed = new Map<
    string,
    { containerId: string; clusterSystemIdentifier: string; moduleLabsAbsent: boolean }
  >();
  for (const cluster of [
    {
      containerId: binding.target.containerId,
      clusterSystemIdentifier: binding.target.clusterSystemIdentifier,
    },
    {
      containerId: binding.target.freshContainerId,
      clusterSystemIdentifier: binding.target.freshClusterSystemIdentifier,
    },
  ]) {
    const admin: MigrationTarget = {
      ...bindTestDatabase(cluster, 'postgres'),
      databaseUser: 'practicehub',
      grant: binding.grant,
    };
    await transport.preflight(admin);
    const inspection = await transport.command(
      ['inspect', '--format', '{{.Id}}', cluster.containerId],
      binding.options,
    );
    requireProof(
      inspection.status === 0 && inspection.stdout.trim() === cluster.containerId,
      'physical CID inspection',
    );
    const result = await transport.execute(
      admin,
      Buffer.from(`SELECT jsonb_build_object('clusterSystemIdentifier',system_identifier::text,
      'moduleLabsAbsent',NOT EXISTS(SELECT FROM pg_roles WHERE rolname='module_labs'),
      'inventoryAbsent',NOT EXISTS(SELECT FROM pg_roles WHERE rolname='module_inventory')) FROM pg_control_system();`),
      binding.options,
    );
    requireProof(result.status === 0, 'physical cluster observation');
    const facts = JSON.parse(result.stdout.trim()) as {
      clusterSystemIdentifier: string;
      moduleLabsAbsent: boolean;
      inventoryAbsent: boolean;
    };
    requireProof(facts.inventoryAbsent === true, 'unconsumed original0066 physical role origin');
    observed.set(cluster.containerId, {
      containerId: inspection.stdout.trim(),
      clusterSystemIdentifier: facts.clusterSystemIdentifier,
      moduleLabsAbsent: facts.moduleLabsAbsent,
    });
  }
  // admitTestClusters is synchronous; the callback returns only the two just-read
  // exact native-owned observations, never invented flags or a historical receipt.
  const admitted = admitTestClusters(binding.target, (admin) => {
    const facts = observed.get(admin.containerId);
    requireProof(facts, 'fresh observed cluster');
    return facts;
  });
  const allocated: BoundDatabase = admitted.database('mix', admitted.primary);
  requireProof(
    allocated.databaseName === binding.database.database,
    'exact admitted database allocation',
  );
  const target = validateMigrationTarget({
    ...allocated,
    databaseUser: 'practicehub',
    grant: binding.grant,
  });
  requireProof(
    testDatabaseArguments(target).includes(target.containerId) &&
      testDatabaseArguments(target).includes(target.databaseName),
    'shared explicit psql routing',
  );
  const context: CaseContext = {
    target,
    admission: binding.target,
    transport,
    options: binding.options,
    forward,
    inverse,
    artifactRoot: join(binding.artifactRoot, 'main'),
    artifactRoots: ['main', 'missing', 'truncated', 'digest'].map((name) =>
      join(binding.artifactRoot, name),
    ),
    observedTarget: binding.database,
    effectCalls: 0,
  };
  requireProof(
    same(await observedTarget(context), binding.database),
    'live admitted database CID/SID/OID/owner/marker/version',
  );
  requireProof(
    (await query(context, "SELECT to_regnamespace('local_migrations') IS NULL;")) === 't',
    'no consumed migration journal',
  );
  validateSources(context);
  return {
    context,
    record: () => {
      writeFileSync(
        join(binding.artifactRoot, 'execution-observations.json'),
        JSON.stringify(
          {
            bindingHash,
            candidateSha256: binding.candidateSha256,
            target: binding.database,
            effectCalls: context.effectCalls,
            observations,
            independentNativeAfterExitAcceptance: false,
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    },
  };
}
interface TargetWitness {
  readonly cid: string;
  readonly sid: string;
  readonly oid: string;
  readonly database: string;
  readonly marker: string;
  readonly owner: string;
  readonly pgVersion: string;
}
interface EventRow {
  tenant_id: string;
  recall_ref: string;
  kind: 'recalled' | 'released';
  lot_ref: string;
  actor: string;
  reason: string;
  event_on: string;
  synthetic: true;
}
interface ArtifactBinding {
  readonly target: TargetWitness;
  readonly sourceSha256: string;
  readonly manifestSha256: string;
  readonly sourceEpoch: 'inventory-0074-seven';
  readonly targetEpoch: 'inventory-0066-six';
  readonly consumer: 'synthetic-proof:inventory-0066-six';
}
interface Artifact {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly count: 4;
  readonly binding: ArtifactBinding;
}
type Rows = Record<string, Record<string, unknown>[]>;

function validateSources(c: CaseContext): void {
  requireProof(c.forward.length === 49, 'ordered49 count');
  requireProof(
    same(
      c.forward.map((m) => ({ path: m.path, sha256: m.sha256, bytes: m.size })),
      forwardPins,
    ),
    'exact ordered49 path/hash/byte manifest',
  );
  requireProof(
    c.forward[40]?.path === originalPath && c.forward[40]?.sha256 === originalHash,
    'original0066 position41 raw bytes',
  );
  requireProof(
    c.forward[48]?.path === eventPath && c.forward[48]?.sha256 === eventHash,
    '0074 position49 raw bytes',
  );
  requireProof(hash(c.inverse) === inverseHash, '0074 inverse raw bytes');
  validateMigrationTarget(c.target);
  requireProof(
    c.target.containerId === c.admission.containerId &&
      c.target.clusterSystemIdentifier === c.admission.clusterSystemIdentifier,
    'allocated primary tuple',
  );
  requireProof(
    c.observedTarget.cid === c.target.containerId &&
      c.observedTarget.sid === c.target.clusterSystemIdentifier &&
      c.observedTarget.database === c.target.databaseName &&
      /^[1-9][0-9]*$/.test(c.observedTarget.oid) &&
      c.observedTarget.owner === 'practicehub' &&
      c.observedTarget.marker.length > 0,
    'observed target tuple',
  );
}
async function execute(c: CaseContext, sql: string | Buffer): Promise<ExecutionResult> {
  return c.transport.execute(c.target, Buffer.isBuffer(sql) ? sql : Buffer.from(sql), c.options);
}
async function query(c: CaseContext, sql: string): Promise<string> {
  const result = await execute(c, sql);
  requireProof(result.status === 0, `query status: ${result.stderr}`);
  return result.stdout.trim();
}
async function json<T>(c: CaseContext, sql: string): Promise<T> {
  return JSON.parse(await query(c, sql)) as T;
}
async function migrate(c: CaseContext, files: readonly Migration[]) {
  c.effectCalls++;
  return runMigrationsAsync(files, (script) => execute(c, script));
}
async function mutate(c: CaseContext, sql: string): Promise<string> {
  c.effectCalls++;
  return query(c, sql);
}
async function journal(c: CaseContext): Promise<string> {
  return query(
    c,
    "SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY position),'[]'::jsonb) FROM local_migrations.applied a;",
  );
}
async function rows(c: CaseContext, events = false): Promise<Rows> {
  const names: string[] = [
    ...inventoryTables.map((t) => `inventory.${t}`),
    ...labsTables.map((t) => `labs.${t}`),
    'payments_ledger.journal',
    'payments_ledger.journal_line',
    'platform_core.synthetic_tenant',
    'platform_core.tenant',
    ...(events ? ['inventory.lot_recall_event'] : []),
  ];
  const result: Rows = {};
  for (const table of names)
    result[table] = await json(
      c,
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM ${table} t;`,
    );
  return result;
}
/** Preserve exact PostgreSQL JSON text too: bigint/xid precision must never rely
 * on JavaScript JSON number round trips. Historical projection removes only the
 * four explicit nullable columns added by0068/0073, checked separately as null.
 */
async function rowBytes(
  c: CaseContext,
  events = false,
  historical = false,
): Promise<Record<string, string>> {
  const tables = [
    ...inventoryTables.map((t) => `inventory.${t}`),
    ...labsTables.map((t) => `labs.${t}`),
    'payments_ledger.journal',
    'payments_ledger.journal_line',
    'platform_core.synthetic_tenant',
    'platform_core.tenant',
    ...(events ? ['inventory.lot_recall_event'] : []),
  ];
  const result: Record<string, string> = {};
  for (const table of tables) {
    const remove =
      historical && table === 'labs.critical_closure'
        ? " - ARRAY['superseded_at','superseded_by','superseded_reason']"
        : historical && table === 'payments_ledger.journal'
          ? " - 'write_off_approval_hash'"
          : '';
    result[table] = await query(
      c,
      `SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) FROM (SELECT to_jsonb(t)${remove} AS value FROM ${table} t) v;`,
    );
  }
  return result;
}
async function fullState(c: CaseContext) {
  return {
    data: await rowBytes(c, true),
    catalog: await security(c),
    identities: await rawIdentity(c),
    journal: await journal(c),
    descriptor: await query(
      c,
      'SELECT jsonb_agg(to_jsonb(d) ORDER BY singleton) FROM local_migrations.descriptor d;',
    ),
  };
}
function equalRows(before: Rows, after: Rows, label: string): void {
  for (const table of Object.keys(before))
    requireProof(same(before[table], after[table]), `${label}: ${table}`);
}
function nonemptyMixed(value: Rows): void {
  for (const table of [
    ...inventoryTables.map((t) => `inventory.${t}`),
    ...labsTables.map((t) => `labs.${t}`),
  ]) {
    requireProof(value[table]?.length === 2, `two rows: ${table}`);
    requireProof(
      same(value[table]?.map((r) => r['tenant_id']).sort(), [...tenants].sort()),
      `two tenants: ${table}`,
    );
  }
  requireProof(value['payments_ledger.journal']?.length === 2, 'two synthetic financial journals');
  requireProof(
    value['payments_ledger.journal_line']?.length === 4,
    'four balanced financial lines',
  );
  for (const tenant of tenants) {
    const lines =
      value['payments_ledger.journal_line']?.filter((r) => r['tenant_id'] === tenant) ?? [];
    requireProof(
      lines.length === 2 &&
        same(lines.map((r) => [r['side'], String(r['amount_minor'])]).sort(), [
          ['credit', '12345'],
          ['debit', '12345'],
        ]),
      `balanced exact financial amounts ${tenant}`,
    );
  }
  requireProof(
    (value['platform_core.synthetic_tenant']?.length ?? 0) > 0,
    'nonempty bootstrap sentinel',
  );
}

/** Stable logical definition and security witnesses. No relpages/reltuples,
 * relfrozenxid, planner statistics or allocation-dependent OIDs are compared here.
 * rawIdentity separately retains OIDs where rollback/replay must preserve them.
 */
async function security(c: CaseContext): Promise<string> {
  return query(
    c,
    `WITH ns AS (SELECT oid,nspname,nspowner,nspacl FROM pg_namespace
   WHERE nspname IN ('public','inventory','labs','payments_ledger','platform_core')),
 rel AS (SELECT c.*,n.nspname FROM pg_class c JOIN ns n ON n.oid=c.relnamespace)
 SELECT jsonb_build_object(
 'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY rolname) FROM
   (SELECT oid::text,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
    rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolconfig,
    shobj_description(oid,'pg_authid') comment FROM pg_roles) r),
 'membership',(SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor) FROM pg_auth_members m),
 'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY setdatabase,setrole) FROM pg_db_role_setting s),
 'namespaces',(SELECT jsonb_agg(jsonb_build_array(nspname,nspowner::regrole::text,nspacl::text)
   ORDER BY nspname) FROM ns),
 'relations',(SELECT jsonb_agg(jsonb_build_array(nspname,relname,relkind,relpersistence,
   relowner::regrole::text,relacl::text,relrowsecurity,relforcerowsecurity,relreplident,
   relispartition,reloptions) ORDER BY nspname,relname) FROM rel),
 'columns',(SELECT jsonb_agg(jsonb_build_array(r.nspname,r.relname,a.attnum,a.attname,
   format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,
   a.attcollation::regcollation::text,a.attacl::text,pg_get_expr(d.adbin,d.adrelid))
   ORDER BY r.nspname,r.relname,a.attnum) FROM pg_attribute a JOIN rel r ON r.oid=a.attrelid
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(r.nspname,r.relname,k.conname,k.contype,
   k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid))
   ORDER BY r.nspname,r.relname,k.conname) FROM pg_constraint k JOIN rel r ON r.oid=k.conrelid),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(r.nspname,r.relname,i.indisvalid,i.indisready,
   i.indislive,pg_get_indexdef(i.indexrelid)) ORDER BY r.nspname,r.relname)
   FROM pg_index i JOIN rel r ON r.oid=i.indexrelid),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(r.nspname,r.relname,t.tgname,t.tgenabled,
   t.tgisinternal,pg_get_triggerdef(t.oid)) ORDER BY r.nspname,r.relname,t.tgname)
   FROM pg_trigger t JOIN rel r ON r.oid=t.tgrelid WHERE NOT t.tgisinternal),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_policies p),
 'functions',(SELECT jsonb_agg(jsonb_build_array(n.nspname,p.proname,p.oid::regprocedure::text,
   p.proowner::regrole::text,p.proacl::text,pg_get_functiondef(p.oid)) ORDER BY n.nspname,p.oid::regprocedure::text)
   FROM pg_proc p JOIN ns n ON n.oid=p.pronamespace WHERE p.prokind IN ('f','p')),
 'default_acl',(SELECT jsonb_agg(jsonb_build_array(d.defaclrole::regrole::text,
   coalesce(n.nspname,''),d.defaclobjtype,d.defaclacl::text) ORDER BY d.defaclrole,d.defaclnamespace,d.defaclobjtype)
   FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace),
 'dependencies',(SELECT jsonb_agg(jsonb_build_array(d.dbid::text,d.classid::regclass::text,
   pg_describe_object(d.classid,d.objid,d.objsubid),d.refobjid::regrole::text,d.deptype)
   ORDER BY d.dbid,d.classid,pg_describe_object(d.classid,d.objid,d.objsubid),d.refobjid,d.deptype)
   FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND
   d.dbid IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))));`,
  );
}
async function rawIdentity(c: CaseContext, excludeEvent = false): Promise<string> {
  return query(
    c,
    `WITH objects AS (SELECT c.oid,c.reltype,c.reltoastrelid,n.nspname,c.relname
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','inventory','labs','payments_ledger','platform_core')
   ${excludeEvent ? "AND NOT (n.nspname='inventory' AND (c.relname='lot_recall_event' OR c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid=to_regclass('inventory.lot_recall_event'))))" : ''})
   SELECT jsonb_build_object('relations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY nspname,relname) FROM objects o),
   'constraints',(SELECT jsonb_agg(jsonb_build_array(k.oid,k.conrelid,k.conname) ORDER BY k.oid)
    FROM pg_constraint k JOIN objects o ON o.oid=k.conrelid),
   'policies',(SELECT jsonb_agg(jsonb_build_array(p.oid,p.polrelid,p.polname) ORDER BY p.oid)
    FROM pg_policy p JOIN objects o ON o.oid=p.polrelid));`,
  );
}
async function inventoryRole(c: CaseContext): Promise<string> {
  return query(
    c,
    `SELECT jsonb_build_object(
 'role',(SELECT to_jsonb(r) FROM (SELECT oid::text,rolname,rolsuper,rolinherit,rolcreaterole,
 rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolconfig
 ,shobj_description(oid,'pg_authid') comment FROM pg_roles WHERE rolname='module_inventory') r),
 'memberships',(SELECT jsonb_agg(jsonb_build_object('role',roleid::regrole::text,'member',member::regrole::text,
 'grantor',grantor::regrole::text,'roleid',roleid::text,'memberid',member::text,'grantorid',grantor::text,
 'admin_option',admin_option,'inherit_option',to_jsonb(m)->'inherit_option','set_option',to_jsonb(m)->'set_option')
 ORDER BY roleid,member,grantor) FROM pg_auth_members m
 WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='module_inventory') OR
 member=(SELECT oid FROM pg_roles WHERE rolname='module_inventory')),
 'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY setdatabase,setrole) FROM pg_db_role_setting s
 WHERE setrole=(SELECT oid FROM pg_roles WHERE rolname='module_inventory')));`,
  );
}
async function sixInventorySecurity(c: CaseContext): Promise<string> {
  return query(
    c,
    `SELECT jsonb_build_object(
 'namespace',(SELECT jsonb_build_array(nspowner::regrole::text,nspacl::text) FROM pg_namespace WHERE nspname='inventory'),
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relowner::regrole::text,c.relacl::text,
 c.relrowsecurity,c.relforcerowsecurity) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='inventory' AND c.relname IN (${inventoryTables.map(literal).join(',')})),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p
 WHERE schemaname='inventory' AND tablename IN (${inventoryTables.map(literal).join(',')})));`,
  );
}
async function assertInventoryPosture(c: CaseContext, event: boolean): Promise<void> {
  const names = [...inventoryTables, ...(event ? ['lot_recall_event'] : [])].sort();
  const actual = await json<
    {
      name: string;
      owner: string;
      rls: boolean;
      force: boolean;
      select: boolean;
      insert: boolean;
      forbidden: boolean;
      policies: number;
    }[]
  >(
    c,
    `SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',c.relowner::regrole::text,
    'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
    'select',has_table_privilege('module_inventory',c.oid,'SELECT'),
    'insert',has_table_privilege('module_inventory',c.oid,'INSERT'),
    'forbidden',has_table_privilege('module_inventory',c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
    'policies',(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='inventory' AND c.relkind='r';`,
  );
  requireProof(
    same(
      actual.map((r) => r.name),
      names,
    ),
    'exact inventory epoch table membership',
  );
  for (const row of actual)
    requireProof(
      row.owner === 'practicehub' &&
        row.rls &&
        row.force &&
        row.select &&
        row.insert &&
        !row.forbidden &&
        row.policies === 1,
      `inventory ACL/RLS posture ${row.name}`,
    );
  requireProof(
    (await query(
      c,
      "SELECT has_schema_privilege('module_inventory','inventory','USAGE') AND NOT has_schema_privilege('module_inventory','inventory','CREATE');",
    )) === 't',
    'inventory schema USAGE only',
  );
}

const seedMixed = `BEGIN;
${tenants
  .map(
    (tenant) => `
INSERT INTO platform_core.tenant(tenant_id,display_name,status,synthetic) VALUES('${tenant}','Synthetic MIX fixture','active',true);
INSERT INTO inventory.product VALUES('${tenant}','product:synthetic01',true);
INSERT INTO inventory.lot VALUES('${tenant}','lot:synthetic01','product:synthetic01','2030-01-01',true);
INSERT INTO inventory.unit VALUES('${tenant}','unit:synthetic01','lot:synthetic01',true);
INSERT INTO inventory.dispense VALUES('${tenant}','dispense:synthetic01','2029-01-01',true);
INSERT INTO inventory.dispense_unit VALUES('${tenant}','dispense:synthetic01','unit:synthetic01',true);
INSERT INTO inventory.recall_unit VALUES('${tenant}','drill:synthetic01','lot:synthetic01','unit:synthetic01','dispense:synthetic01',true);
INSERT INTO labs.lab_order(tenant_id,order_id,subject_ref,loinc_code,loinc_display,ordered_at,expected_result_by,status,service_request_id,synthetic)
 VALUES('${tenant}','o','subject','123','Synthetic','2026-01-01','2026-01-02','awaiting-result','sr',true);
INSERT INTO labs.lab_result(tenant_id,result_id,order_id,value_text,critical,recorded_at,source,provisional,reconciliation,read_back_by,read_back_at,read_back_value,observation_id,report_id,synthetic)
 VALUES('${tenant}','r','o','7',true,'2026-01-01','electronic',false,'not-applicable','human:synthetic','2026-01-01','7','obs','report',true);
INSERT INTO labs.critical_closure(tenant_id,closure_id,order_id,result_id,phase,paged_at,work_item_id,synthetic)
 VALUES('${tenant}','c','o','r','paged','2026-01-01','work',true);
INSERT INTO labs.expected_result_age VALUES('${tenant}','o','2026-01-03','2026-01-02','age',true);
INSERT INTO labs.device_calibration VALUES('${tenant}','r','device','lot','2025-12-31','synthetic',true);
INSERT INTO labs.device_recall VALUES('${tenant}','recall','device','lot','r','2026-01-04',true);
INSERT INTO payments_ledger.journal(tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic)
 VALUES('${tenant}','mix-journal','mix-correlation','mix-idempotency',repeat('a',64),'2026-01-01',true);
INSERT INTO payments_ledger.journal_line(tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
 VALUES('${tenant}','mix-journal',1,'mix-receivable','debit',12345,'USD','mix-source',true),
 ('${tenant}','mix-journal',2,'mix-revenue','credit',12345,'USD','mix-source',true);`,
  )
  .join('\n')}
COMMIT;`;

const events: EventRow[] = tenants.flatMap((tenant) =>
  (['recalled', 'released'] as const).map((kind) => ({
    tenant_id: tenant,
    recall_ref: 'recall:synthetic01',
    kind,
    lot_ref: 'lot:synthetic01',
    actor: 'human:synthetic',
    reason: `Synthetic ${kind}`,
    event_on: kind === 'recalled' ? '2026-01-03' : '2026-01-04',
    synthetic: true as const,
  })),
);
function validateEvents(value: unknown): asserts value is EventRow[] {
  requireProof(Array.isArray(value) && value.length === 4, 'exact four events');
  // Finite fixture: exact equality also refuses unknown keys, duplicate kinds,
  // changed reason/date, nonhuman actors and missing/reassigned synthetic rows.
  const sorted = [...value].sort((a: EventRow, b: EventRow) =>
    `${a.tenant_id}/${a.kind}`.localeCompare(`${b.tenant_id}/${b.kind}`),
  );
  const expected = [...events].sort((a, b) =>
    `${a.tenant_id}/${a.kind}`.localeCompare(`${b.tenant_id}/${b.kind}`),
  );
  for (let i = 0; i < 4; i++) {
    const row = sorted[i] as Record<string, unknown>;
    const wanted = expected[i] as unknown as Record<string, unknown>;
    requireProof(same(Object.keys(row).sort(), Object.keys(wanted).sort()), 'exact event keys');
    for (const key of Object.keys(wanted))
      requireProof(same(row[key], wanted[key]), `event ${i} ${key}`);
  }
}
function eventInsert(value: readonly EventRow[]): string {
  return `INSERT INTO inventory.lot_recall_event(tenant_id,recall_ref,kind,lot_ref,actor,reason,event_on,synthetic) VALUES ${value
    .map(
      (r) =>
        `(${[r.tenant_id, r.recall_ref, r.kind, r.lot_ref, r.actor, r.reason, r.event_on].map(literal).join(',')},true)`,
    )
    .join(',')};`;
}
function artifactBinding(c: CaseContext): ArtifactBinding {
  return {
    target: c.observedTarget,
    sourceSha256: eventHash,
    manifestSha256: buildMigrationScript(c.forward).manifestSha256,
    sourceEpoch: 'inventory-0074-seven',
    targetEpoch: 'inventory-0066-six',
    consumer: 'synthetic-proof:inventory-0066-six',
  };
}
function readArtifact(artifact: Artifact, c: CaseContext): EventRow[] {
  requireProof(same(artifact.binding, artifactBinding(c)), 'artifact target/source/epoch');
  const root = dirname(artifact.path);
  requireProof(c.artifactRoots.includes(root), 'allocated artifact root');
  canonicalPath(root, true);
  requireProof(
    /^[a-f0-9]{64}$/.test(artifact.sha256) &&
      artifact.path === join(root, `events-${artifact.sha256}.json`),
    'content address',
  );
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(artifact.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('MIX assertion: artifact missing', { cause: error });
    throw error;
  }
  requireProof(
    stat.isFile() && !stat.isSymbolicLink() && realpathSync(artifact.path) === artifact.path,
    'regular owned artifact',
  );
  const bytes = readFileSync(artifact.path);
  requireProof(
    bytes.length === artifact.bytes && stat.size === artifact.bytes,
    'artifact byte count',
  );
  requireProof(hash(bytes) === artifact.sha256, 'artifact digest');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  validateEvents(value);
  requireProof(artifact.count === value.length, 'artifact count');
  return value;
}
async function preserve(c: CaseContext): Promise<Artifact> {
  const value = await json<unknown>(
    c,
    'SELECT jsonb_agg(to_jsonb(e) ORDER BY tenant_id,kind) FROM inventory.lot_recall_event e;',
  );
  validateEvents(value);
  const bytes = Buffer.from(JSON.stringify(value));
  const sha256 = hash(bytes);
  const path = join(c.artifactRoot, `events-${sha256}.json`);
  canonicalPath(c.artifactRoot, true);
  writeFileSync(path, bytes, { flag: 'wx' });
  const artifact: Artifact = {
    path,
    sha256,
    bytes: bytes.length,
    count: 4,
    binding: artifactBinding(c),
  };
  readArtifact(artifact, c);
  return artifact;
}

/** MIX-I1: must be the first original0066 on the allocated physical cluster. */
async function mixedOriginal(c: CaseContext): Promise<void> {
  validateSources(c);
  expect(await migrate(c, c.forward.slice(0, 40))).toMatchObject({
    applied: 40,
    skipped: 0,
    total: 40,
  });
  const prefix40 = await journal(c);
  const origin = await inventoryRole(c);
  requireProof(JSON.parse(origin).role === null, 'module_inventory absent before original0066');
  expect(await migrate(c, c.forward.slice(0, 41))).toMatchObject({
    applied: 1,
    skipped: 40,
    total: 41,
  });
  const born = await inventoryRole(c);
  const role = JSON.parse(born) as {
    role: Record<string, unknown>;
    memberships: Record<string, unknown>[];
    settings: unknown;
  };
  requireProof(
    role.role && /^[1-9][0-9]*$/.test(String(role.role['oid'])),
    'created module_inventory OID',
  );
  for (const key of [
    'rolsuper',
    'rolcreaterole',
    'rolcreatedb',
    'rolcanlogin',
    'rolreplication',
    'rolbypassrls',
  ])
    requireProof(role.role[key] === false, `original0066 ${key}=false`);
  requireProof(
    role.role['rolname'] === 'module_inventory' &&
      role.role['rolinherit'] === true &&
      role.role['rolconnlimit'] === -1 &&
      role.role['rolvaliduntil'] === null &&
      role.role['rolconfig'] === null &&
      role.role['comment'] === null &&
      role.settings === null,
    'original0066 complete default role posture',
  );
  requireProof(role.memberships.length === 1, 'exact original0066 membership');
  const membership = role.memberships[0];
  requireProof(membership, 'original0066 membership exists');
  const supportsOptions = Number(c.observedTarget.pgVersion) >= 160000;
  requireProof(
    membership['role'] === 'module_inventory' &&
      membership['member'] === 'practicehub_app' &&
      membership['grantor'] === 'practicehub' &&
      membership['roleid'] === role.role['oid'] &&
      membership['admin_option'] === false &&
      membership['inherit_option'] === (supportsOptions ? true : null) &&
      membership['set_option'] === (supportsOptions ? true : null),
    'original0066 membership grantor and all options',
  );
  const identity = await json<{ app: string; admin: string }>(
    c,
    "SELECT jsonb_build_object('app',(SELECT oid::text FROM pg_roles WHERE rolname='practicehub_app'),'admin',(SELECT oid::text FROM pg_roles WHERE rolname='practicehub'));",
  );
  requireProof(
    membership['memberid'] === identity.app && membership['grantorid'] === identity.admin,
    'membership exact member/grantor OIDs',
  );
  await assertInventoryPosture(c, false);
  requireProof(
    same(JSON.parse(await journal(c)).slice(0, 40), JSON.parse(prefix40)),
    'raw prefix40',
  );
  await mutate(c, seedMixed);
  const populated = await rows(c);
  nonemptyMixed(populated);
  const historicalBytes = await rowBytes(c, false, true);
  const rawJournal = await journal(c);
  const six = await sixInventorySecurity(c);
  requireProof(
    (await query(c, "SELECT to_regclass('inventory.lot_recall_event') IS NULL;")) === 't',
    'six-table replay epoch',
  );
  // Direct original byte replay is intentionally separate from journal skip proof.
  const original = c.forward[40];
  requireProof(original, 'original source');
  await mutate(c, `BEGIN;\n${original.bytes.toString('utf8')}\nCOMMIT;`);
  equalRows(populated, await rows(c), '0066 replay rows');
  requireProof(
    same(await rowBytes(c, false, true), historicalBytes),
    '0066 replay exact data bytes',
  );
  requireProof((await journal(c)) === rawJournal, '0066 replay raw journal');
  requireProof((await inventoryRole(c)) === born, '0066 replay role/grantor/options');
  requireProof((await sixInventorySecurity(c)) === six, '0066 replay ACL/RLS');
  expect(await migrate(c, c.forward.slice(0, 41))).toMatchObject({
    applied: 0,
    skipped: 41,
    total: 41,
  });
  expect(await migrate(c, c.forward.slice(0, 42))).toMatchObject({
    applied: 1,
    skipped: 41,
    total: 42,
  });
  const prefix42 = await journal(c);
  expect(await migrate(c, c.forward)).toMatchObject({ applied: 7, skipped: 42, total: 49 });
  requireProof(
    same(JSON.parse(await journal(c)).slice(0, 42), JSON.parse(prefix42)),
    'unchanged raw prefix42',
  );
  // 0073 adds three nullable critical-closure columns. Compare every historical
  // field and require the new columns to be null; no blanket projection of rows.
  const advanced = await rows(c);
  for (const row of advanced['labs.critical_closure'] ?? []) {
    for (const key of ['superseded_at', 'superseded_by', 'superseded_reason']) {
      requireProof(row[key] === null, `0073 new nullable field ${key}`);
      switch (key) {
        case 'superseded_at':
          delete row['superseded_at'];
          break;
        case 'superseded_by':
          delete row['superseded_by'];
          break;
        case 'superseded_reason':
          delete row['superseded_reason'];
          break;
      }
    }
  }
  for (const row of advanced['payments_ledger.journal'] ?? []) {
    requireProof(row['write_off_approval_hash'] === null, '0068 nullable approval hash');
    delete row['write_off_approval_hash'];
  }
  equalRows(populated, advanced, 'suffix historical data');
  requireProof(
    same(await rowBytes(c, false, true), historicalBytes),
    'suffix exact historical data bytes',
  );
  requireProof((await inventoryRole(c)) === born, 'suffix inventory role/membership');
  requireProof((await sixInventorySecurity(c)) === six, 'suffix six-table ACL/RLS');
  await assertInventoryPosture(c, true);
  const headRows = await rows(c),
    headData = await rowBytes(c),
    headSecurity = await security(c),
    headJournal = await journal(c),
    headIdentity = await rawIdentity(c);
  expect(await migrate(c, c.forward)).toMatchObject({ applied: 0, skipped: 49, total: 49 });
  equalRows(headRows, await rows(c), 'full replay');
  requireProof(same(await rowBytes(c), headData), 'full replay exact data bytes');
  requireProof(
    (await security(c)) === headSecurity && (await journal(c)) === headJournal,
    'full replay security/raw journal',
  );
  requireProof((await rawIdentity(c)) === headIdentity, 'full replay raw object identities');
}

const tail = (ordinal: string, name: string, bytes: Uint8Array): Migration =>
  new Migration(`modules/inventory/migrations/${ordinal}-mix-${name}.sql`, bytes);

/** MIX-I3 is ordered before successful I2 so all failures retain prefix49.
 * These three are intended independent transactions on the SAME database;
 * if a failure commits or readback differs, abort—never reset/retry/recreate.
 */
async function mixedFailures(c: CaseContext): Promise<void> {
  for (const mode of ['sql', 'journal-insert', 'deferred-commit'] as const) {
    const before = await fullState(c);
    validateEvents((await rows(c, true))['inventory.lot_recall_event']);
    const dropped = `MIX_${mode}_DROPPED`,
      sqlDone = `MIX_${mode}_SQL_DONE`,
      inserting = `MIX_${mode}_INSERT_ATTEMPT`,
      inserted = `MIX_${mode}_INSERT_DONE`;
    const suffix =
      mode === 'sql'
        ? '\nSELECT 1/0;'
        : mode === 'deferred-commit'
          ? '\nCREATE TABLE public.mix_commit_failure(id int CONSTRAINT mix_deferred_unique UNIQUE DEFERRABLE INITIALLY DEFERRED); INSERT INTO public.mix_commit_failure VALUES(1),(1);'
          : '';
    const proof = `\nDO $mix_drop$ BEGIN IF to_regclass('inventory.lot_recall_event') IS NOT NULL THEN RAISE EXCEPTION 'MIX inverse did not DROP'; END IF; END $mix_drop$;\nSELECT ${literal(dropped)};\n`;
    const migration = tail(
      '9000',
      mode,
      Buffer.concat([c.inverse, Buffer.from(proof + suffix + `\nSELECT ${literal(sqlDone)};`)]),
    );
    const files = [...c.forward, migration];
    let observed: ExecutionResult | undefined;
    let rejected: unknown;
    try {
      c.effectCalls++;
      await runMigrationsAsync(files, async (script) => {
        let text = script.toString('utf8');
        // Instrument precisely the runner-generated journal boundary, leaving
        // all original/inverse payload bytes intact. Refuse any runner drift.
        const insertLine = text
          .split('\n')
          .filter(
            (line) =>
              line.startsWith('INSERT INTO local_migrations.applied(') &&
              line.includes(`VALUES(50,${literal(migration.path)},`),
          );
        requireProof(
          insertLine.length === 1 && insertLine[0],
          'single exact tail journal boundary',
        );
        const originalLine = insertLine[0];
        let faultLine = originalLine;
        if (mode === 'journal-insert') {
          const needle = `VALUES(50,${literal(migration.path)},`;
          requireProof(
            originalLine.split(needle).length === 2,
            'single fault at exact tail journal INSERT',
          );
          faultLine = originalLine.replace(needle, `VALUES(0,${literal(migration.path)},`);
        }
        requireProof(
          text.split(`${originalLine}\nCOMMIT;`).length === 2,
          'exact journal followed by COMMIT',
        );
        text = text.replace(
          `${originalLine}\nCOMMIT;`,
          `SELECT ${literal(inserting)};\n${faultLine}\nSELECT ${literal(inserted)};\nCOMMIT;`,
        );
        observed = await execute(c, Buffer.from('\\set VERBOSITY verbose\n' + text));
        return observed;
      });
    } catch (error) {
      rejected = error;
    }
    requireProof(
      rejected instanceof Error && rejected.message.includes('Migration attempt failed'),
      `${mode} actual runner failure`,
    );
    requireProof(observed && observed.status === 3, `${mode} psql ON_ERROR_STOP exit3`);
    const code = mode === 'sql' ? '22012' : mode === 'journal-insert' ? '23514' : '23505';
    requireProof(
      new RegExp(`ERROR:\\s+${code}:`).test(observed.stderr),
      `${mode} SQLSTATE ${code}`,
    );
    requireProof(
      observed.stdout.includes(`:attempt:${migration.path}`) &&
        !observed.stdout.includes(`:committed:${migration.path}`),
      `${mode} attempted not committed phase`,
    );
    const lines = observed.stdout.split(/\r?\n/).map((line) => line.trim());
    requireProof(
      lines.filter((line) => line === dropped).length === 1,
      `${mode} genuine DROP reached`,
    );
    requireProof(lines.includes(sqlDone) === (mode !== 'sql'), `${mode} SQL-completion phase`);
    requireProof(lines.includes(inserting) === (mode !== 'sql'), `${mode} journal-attempt phase`);
    requireProof(
      lines.includes(inserted) === (mode === 'deferred-commit'),
      `${mode} journal-insert completion phase`,
    );
    if (mode === 'sql')
      requireProof(observed.stderr.includes('division by zero'), 'SQL division-by-zero class');
    if (mode === 'journal-insert')
      requireProof(
        observed.stderr.includes('applied_position_check') &&
          /TABLE NAME:\s+applied/.test(observed.stderr),
        'journal INSERT constraint/table provenance',
      );
    if (mode === 'deferred-commit')
      requireProof(
        observed.stderr.includes('mix_deferred_unique') &&
          /TABLE NAME:\s+mix_commit_failure/.test(observed.stderr),
        'deferred COMMIT constraint/table provenance',
      );
    requireProof(
      same(await fullState(c), before),
      `${mode} complete data/catalog/OID/role/raw-prefix rollback`,
    );
    requireProof(
      (await query(c, "SELECT to_regclass('public.mix_commit_failure') IS NULL;")) === 't',
      `${mode} no deferred fixture left`,
    );
  }
}

/** MIX-I2 success: exact inverse and forward each are a distinct append-only tail. */
async function mixedRestore(
  c: CaseContext,
  artifact: Artifact,
  controls: readonly ArtifactControl[],
): Promise<void> {
  const before = await rows(c, true),
    data = await rowBytes(c, true),
    prefix = await journal(c),
    descriptor = await query(
      c,
      'SELECT jsonb_agg(to_jsonb(d) ORDER BY singleton) FROM local_migrations.descriptor d;',
    ),
    catalog = await security(c),
    unchangedIds = await rawIdentity(c, true),
    role = await inventoryRole(c),
    six = await sixInventorySecurity(c);
  validateEvents(before['inventory.lot_recall_event']);
  const inverse = tail('9001', 'inverse', c.inverse);
  await inverseFromArtifact(c, artifact);
  requireProof(
    (await query(c, "SELECT to_regclass('inventory.lot_recall_event') IS NULL;")) === 't',
    'genuine event DROP',
  );
  const forward = c.forward[48];
  requireProof(forward, 'forward source');
  const reapply = tail('9002', 'reapply', forward.bytes);
  expect(await migrate(c, [...c.forward, inverse, reapply])).toMatchObject({
    applied: 1,
    skipped: 50,
    total: 51,
  });
  requireProof(
    (await query(c, 'SELECT count(*) FROM inventory.lot_recall_event;')) === '0',
    'reapply alone restores zero events',
  );
  await artifactMutants(c, controls, 'restore');
  await restoreFromArtifact(c, artifact);
  equalRows(before, await rows(c, true), 'file-driven four-event restoration');
  requireProof(same(await rowBytes(c, true), data), 'file-driven restore exact data bytes');
  requireProof(
    same(JSON.parse(await journal(c)).slice(0, 49), JSON.parse(prefix)),
    'success raw original49 prefix',
  );
  requireProof(
    (await inventoryRole(c)) === role && (await sixInventorySecurity(c)) === six,
    'restore original role/six-table security',
  );
  requireProof(
    (await security(c)) === catalog,
    'restore full logical catalog/ACL/RLS/grantor/options',
  );
  requireProof(
    (await rawIdentity(c, true)) === unchangedIds,
    'restore unaffected raw object identities',
  );
  requireProof(
    (await query(
      c,
      'SELECT jsonb_agg(to_jsonb(d) ORDER BY singleton) FROM local_migrations.descriptor d;',
    )) === descriptor,
    'restore descriptor unchanged',
  );
  await assertInventoryPosture(c, true);
  const restoredState = await fullState(c);
  expect(await migrate(c, [...c.forward, inverse, reapply])).toMatchObject({
    applied: 0,
    skipped: 51,
    total: 51,
  });
  requireProof(
    same(await fullState(c), restoredState),
    '51-entry replay has zero data/security/journal effects',
  );
}

/** MIX-I4 finite assertion mutants: no database writes and no mutation sweep. */
function rowMutants(before: Rows): void {
  for (const table of ['inventory.unit', 'labs.lab_result', 'payments_ledger.journal_line']) {
    const mutant = structuredClone(before);
    requireProof((mutant[table]?.length ?? 0) > 0, `mutant prerequisite ${table}`);
    mutant[table]?.pop();
    expect(() => equalRows(before, mutant, 'loss-control')).toThrow(
      `MIX assertion: loss-control: ${table}`,
    );
  }
}
interface ArtifactControl {
  readonly name: string;
  readonly artifact: Artifact;
  readonly failure: string;
}
function prepareArtifactControls(c: CaseContext, artifact: Artifact): readonly ArtifactControl[] {
  const [main, missing, truncated, digest] = c.artifactRoots;
  requireProof(
    main === c.artifactRoot && missing && truncated && digest,
    'four allocated artifact directories',
  );
  const original = readFileSync(artifact.path);
  const missingFile = join(missing, `events-${artifact.sha256}.json`);
  const truncatedFile = join(truncated, `events-${artifact.sha256}.json`);
  const digestFile = join(digest, `events-${artifact.sha256}.json`);
  requireProof(
    readdirSync(missing).length === 0 &&
      readdirSync(truncated).length === 0 &&
      readdirSync(digest).length === 0,
    'counterexample directories initially empty',
  );
  writeFileSync(truncatedFile, original.subarray(0, original.length - 1), { flag: 'wx' });
  const mutant = Buffer.from(original);
  requireProof(mutant.length > 0 && mutant[0] !== undefined, 'one-byte artifact prerequisite');
  mutant[0] = mutant[0] ^ 1;
  requireProof(
    mutant.length === original.length &&
      [...mutant].filter((value, index) => value !== original[index]).length === 1,
    'exactly one byte mutated',
  );
  writeFileSync(digestFile, mutant, { flag: 'wx' });
  return [
    {
      name: 'missing-content-address',
      artifact: { ...artifact, path: missingFile },
      failure: 'artifact missing',
    },
    {
      name: 'truncated-file',
      artifact: { ...artifact, path: truncatedFile },
      failure: 'artifact byte count',
    },
    {
      name: 'one-byte-digest',
      artifact: { ...artifact, path: digestFile },
      failure: 'artifact digest',
    },
    {
      name: 'wrong-target',
      artifact: {
        ...artifact,
        binding: {
          ...artifact.binding,
          target: {
            ...artifact.binding.target,
            oid: (BigInt(artifact.binding.target.oid) + 1n).toString(),
          },
        },
      },
      failure: 'artifact target/source/epoch',
    },
    {
      name: 'wrong-epoch',
      artifact: {
        ...artifact,
        binding: {
          ...artifact.binding,
          sourceEpoch: 'inventory-0066-six',
        } as unknown as ArtifactBinding,
      },
      failure: 'artifact target/source/epoch',
    },
  ];
}
function artifactBytes(c: CaseContext): unknown {
  return c.artifactRoots.map((root) => ({
    root,
    files: readdirSync(root)
      .sort()
      .map((name) => {
        const path = join(root, name);
        canonicalPath(path, false);
        const bytes = readFileSync(path);
        return { name, bytes: bytes.length, sha256: hash(bytes) };
      }),
  }));
}
async function artifactMutants(
  c: CaseContext,
  controls: readonly ArtifactControl[],
  operation: 'inverse' | 'restore',
): Promise<void> {
  requireProof(controls.length === 5, 'finite five artifact controls');
  for (const control of controls) {
    const before = await fullState(c),
      files = artifactBytes(c),
      calls = c.effectCalls;
    const action = operation === 'inverse' ? inverseFromArtifact : restoreFromArtifact;
    await expect(action(c, control.artifact)).rejects.toThrow(`MIX assertion: ${control.failure}`);
    requireProof(
      c.effectCalls === calls,
      `${operation}/${control.name} refused before mutation submission`,
    );
    requireProof(
      same(await fullState(c), before),
      `${operation}/${control.name} zero database effects`,
    );
    requireProof(
      same(artifactBytes(c), files),
      `${operation}/${control.name} zero artifact effects`,
    );
  }
}
async function observedTarget(c: CaseContext): Promise<TargetWitness> {
  // The native transport pins SID/database/user before this payload; CID was
  // inspected during admission, then every operation routes to that same CID.
  return json(
    c,
    `SELECT jsonb_build_object('cid',${literal(c.target.containerId)},
   'sid',(SELECT system_identifier::text FROM pg_control_system()),'oid',d.oid::text,
   'database',d.datname,'marker',shobj_description(d.oid,'pg_database'),
   'owner',d.datdba::regrole::text,'pgVersion',current_setting('server_version_num'))
   FROM pg_database d WHERE d.datname=current_database();`,
  );
}
async function artifactGuard(
  c: CaseContext,
  artifact: Artifact,
  restore: boolean,
): Promise<EventRow[]> {
  const disk = readArtifact(artifact, c); // All byte/binding refusals precede any mutation.
  requireProof(
    same(await observedTarget(c), artifact.binding.target),
    'live artifact target tuple',
  );
  await assertInventoryPosture(c, true);
  if (restore)
    requireProof(
      (await query(c, 'SELECT count(*) FROM inventory.lot_recall_event;')) === '0',
      'restore empty seven-table epoch',
    );
  else {
    const current = await json<unknown>(
      c,
      'SELECT jsonb_agg(to_jsonb(e) ORDER BY tenant_id,kind) FROM inventory.lot_recall_event e;',
    );
    validateEvents(current);
    requireProof(same(current, disk), 'export matches current event history before inverse');
  }
  return disk;
}
async function inverseFromArtifact(c: CaseContext, artifact: Artifact): Promise<void> {
  await artifactGuard(c, artifact, false);
  expect(await migrate(c, [...c.forward, tail('9001', 'inverse', c.inverse)])).toMatchObject({
    applied: 1,
    skipped: 49,
    total: 50,
  });
}
async function restoreFromArtifact(c: CaseContext, artifact: Artifact): Promise<void> {
  const disk = await artifactGuard(c, artifact, true);
  const prefix = await journal(c);
  await mutate(c, `BEGIN;\n${eventInsert(disk)}\nCOMMIT;`);
  requireProof((await journal(c)) === prefix, 'restore never mutates journal');
}

async function intendedSequence(c: CaseContext): Promise<void> {
  await mixedOriginal(c);
  await mutate(c, `BEGIN;${eventInsert(events)}COMMIT;`);
  const artifact = await preserve(c);
  const controls = prepareArtifactControls(c, artifact);
  await artifactMutants(c, controls, 'inverse');
  const controlsBefore = await fullState(c),
    calls = c.effectCalls;
  rowMutants(await rows(c, true));
  requireProof(
    c.effectCalls === calls && same(await fullState(c), controlsBefore),
    'row witness controls have no database effects',
  );
  await mixedFailures(c); // If any fails, stop without reset or replacement.
  await mixedRestore(c, artifact, controls);
}

describe('finite populated inventory journal proof — explicit physical grant required', () => {
  it('MIX-I1..MIX-I4 preserve mixed data, exact journal and security across the finite sequence', async () => {
    const { context, record } = await assemble();
    try {
      await intendedSequence(context);
    } finally {
      record();
    }
  }, 1800000);
});
