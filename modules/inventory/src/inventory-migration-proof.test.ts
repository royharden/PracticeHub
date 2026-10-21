import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  guardedInverse,
  guardedRestore,
  validateEventRoleTransition,
  readEventArtifact,
  tenants,
  validateRolePosture,
  type EventDescriptor,
  type InverseExpectation,
  type InverseObservation,
  type ProofBinding,
  type ProofEvent,
  type roleProvenance,
} from './db-test-harness.js';

function fixtureRow<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Test setup missing fixture row');
  return value;
}

let root: string;
let binding: ProofBinding;
let descriptor: EventDescriptor;
let expected: InverseExpectation;
let observed: InverseObservation;
const rows = (): ProofEvent[] =>
  tenants.flatMap((tenant_id) =>
    (['recalled', 'released'] as const).map((kind) => ({
      tenant_id,
      kind,
      recall_ref: 'recall:synthetic01',
      lot_ref: 'lot:synthetic01',
      actor: 'human:synthetic01',
      reason: 'Synthetic recall proof',
      event_on: '2029-01-02',
      synthetic: true as const,
    })),
  );
function artifact(value: unknown, raw?: string): EventDescriptor {
  const bytes = Buffer.from(raw ?? `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = join(root, `events-${sha256}.json`);
  writeFileSync(path, bytes, { flag: 'wx' });
  return { path, bytes: bytes.length, sha256, count: 4, binding };
}
beforeEach(() => {
  root = resolve(mkdtempSync(join(tmpdir(), 'inventory-proof-unit-')));
  binding = {
    target: {
      cid: 'a'.repeat(64),
      sid: '123456789',
      oid: '34567',
      database: 'ph_inventory_proof_unit',
      marker: 'PracticeHub inventory disposable proof: unit',
      owner: 'proof_owner',
      pgVersion: '160004',
    },
    sourceSha256: 'b'.repeat(64),
    ownedRoot: root,
    artifactOwner: 'inventory-proof-unit',
    sourceEpoch: 'inventory-0074-seven',
    targetEpoch: 'inventory-0066-six',
    consumer: { mode: 'synthetic-proof', version: 'inventory-0066-six', compatible: true },
  };
  writeFileSync(join(root, 'inventory-proof-owner.json'), JSON.stringify(binding), { flag: 'wx' });
  descriptor = artifact(rows());
  expected = {
    binding,
    catalog: {
      schema: 'inventory',
      owner: 'proof_owner',
      kind: 'r',
      persistence: 'p',
      rls: true,
      force: true,
      columns: ['accepted'],
      constraints: ['accepted'],
      indexes: ['accepted'],
      policies: ['tenant_isolation'],
      acl: ['SELECT', 'INSERT'],
    },
    roles: { safe: true },
  };
  observed = {
    target: { ...binding.target },
    epoch: 'inventory-0074-seven',
    catalog: structuredClone(expected.catalog),
    roles: { safe: true },
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function refusesBeforeDrop(pattern: RegExp): Promise<void> {
  let calls = 0;
  await expect(
    guardedInverse(
      descriptor,
      expected,
      async () => observed,
      async () => {
        calls++;
      },
    ),
  ).rejects.toThrow(pattern);
  expect(calls).toBe(0);
}

describe('disk descriptor inverse preflight invocation sentinels', () => {
  it('accepts exact bytes and target and calls destructive seam once', async () => {
    let calls = 0;
    await guardedInverse(
      descriptor,
      expected,
      async () => observed,
      async () => {
        calls++;
      },
    );
    expect(calls).toBe(1);
    expect(readEventArtifact(descriptor, binding)).toEqual(rows());
  });
  for (const key of ['cid', 'sid', 'oid', 'database', 'marker', 'owner', 'pgVersion'] as const) {
    it(`refuses observed target ${key} mismatch before DROP`, async () => {
      observed.target[key] += 'wrong';
      await refusesBeforeDrop(/target identity/);
    });
  }
  it('refuses missing file before DROP', async () => {
    descriptor = {
      ...descriptor,
      sha256: 'c'.repeat(64),
      path: join(root, `events-${'c'.repeat(64)}.json`),
    };
    await refusesBeforeDrop(/ENOENT/);
  });
  it('refuses same-size corruption before DROP', async () => {
    const raw = readFileSync(descriptor.path, 'utf8');
    writeFileSync(descriptor.path, raw.replace('human:', 'agent:'));
    await refusesBeforeDrop(/artifact digest/);
  });
  it('refuses truncated bytes before DROP', async () => {
    writeFileSync(descriptor.path, readFileSync(descriptor.path).subarray(0, 12));
    await refusesBeforeDrop(/artifact byte count/);
  });
  it('refuses wrong declared digest before DROP', async () => {
    const path = join(root, `events-${'d'.repeat(64)}.json`);
    writeFileSync(path, readFileSync(descriptor.path), { flag: 'wx' });
    descriptor = { ...descriptor, path, sha256: 'd'.repeat(64) };
    await refusesBeforeDrop(/artifact digest/);
  });
  it('refuses invalid JSON with matching digest before DROP', async () => {
    descriptor = artifact(null, '{invalid JSON');
    await refusesBeforeDrop(/JSON|property name/);
  });
  it('refuses descriptor count mismatch before DROP', async () => {
    descriptor.count = 3;
    await refusesBeforeDrop(/artifact row count/);
  });
  it('refuses nonabsolute path before DROP', async () => {
    descriptor.path = 'events.json';
    await refusesBeforeDrop(/owned absolute path/);
  });
  it('refuses path outside owned root before DROP', async () => {
    descriptor.path = join(resolve(root, '..'), `events-${descriptor.sha256}.json`);
    await refusesBeforeDrop(/owned direct child path/);
  });
  it('refuses directory as artifact before DROP', async () => {
    descriptor = {
      ...descriptor,
      sha256: 'e'.repeat(64),
      path: join(root, `events-${'e'.repeat(64)}.json`),
    };
    mkdirSync(descriptor.path);
    await refusesBeforeDrop(/regular nonsymlink artifact/);
  });
  it('refuses changed owned-root marker before DROP', async () => {
    writeFileSync(
      join(root, 'inventory-proof-owner.json'),
      JSON.stringify({ ...binding, artifactOwner: 'another-owner' }),
    );
    await refusesBeforeDrop(/owned root binding/);
  });
  it('refuses source digest binding mismatch before DROP', async () => {
    descriptor = { ...descriptor, binding: { ...binding, sourceSha256: 'f'.repeat(64) } };
    await refusesBeforeDrop(/artifact binding/);
  });
  for (const field of [
    'schema',
    'owner',
    'columns',
    'constraints',
    'indexes',
    'policies',
    'acl',
    'rls',
    'force',
    'kind',
    'persistence',
  ] as const) {
    it(`refuses altered event catalog ${field} before DROP`, async () => {
      if (!observed.catalog) throw new Error('Test setup missing catalog');
      observed.catalog[field] = 'mutated';
      await refusesBeforeDrop(/event catalog/);
    });
  }
  it('refuses wrongly bound event owner before DROP', async () => {
    expected.catalog['owner'] = 'someone_else';
    await refusesBeforeDrop(/event owner\/schema/);
  });
  it('refuses absent event before DROP', async () => {
    observed.catalog = undefined;
    await refusesBeforeDrop(/event catalog/);
  });
  it('refuses six-table inverse source epoch before DROP', async () => {
    observed.epoch = 'inventory-0066-six';
    await refusesBeforeDrop(/inverse epoch/);
  });
  it('refuses wrong source epoch binding before DROP', async () => {
    Object.assign(binding, { sourceEpoch: 'unaccepted' });
    await refusesBeforeDrop(/source\/target epoch/);
  });
  it('refuses absent consumer posture before DROP', async () => {
    Object.assign(binding, { consumer: undefined });
    await refusesBeforeDrop(/compatible consumer posture/);
  });
  it('refuses incompatible consumer version before DROP', async () => {
    Object.assign(binding.consumer, { version: 'inventory-0074-seven' });
    await refusesBeforeDrop(/compatible consumer posture/);
  });
  it('refuses changed role posture before DROP', async () => {
    observed.roles = { safe: false };
    await refusesBeforeDrop(/inverse role posture/);
  });
  const rowMutants: readonly [string, (values: Record<string, unknown>[]) => void, RegExp][] = [
    [
      'nonsynthetic',
      (value) => {
        fixtureRow(value[0])['synthetic'] = false;
      },
      /synthetic tenant\/row/,
    ],
    [
      'unknown tenant',
      (value) => {
        fixtureRow(value[0])['tenant_id'] = 'other-synthetic';
      },
      /synthetic tenant\/row/,
    ],
    [
      'extra key',
      (value) => {
        fixtureRow(value[0])['extra'] = true;
      },
      /exact event keys/,
    ],
    [
      'missing key',
      (value) => {
        delete fixtureRow(value[0])['reason'];
      },
      /exact event keys/,
    ],
    [
      'bad token',
      (value) => {
        fixtureRow(value[0])['recall_ref'] = 'bad';
      },
      /event tokens/,
    ],
    [
      'unknown kind',
      (value) => {
        fixtureRow(value[0])['kind'] = 'unknown';
      },
      /event kind/,
    ],
    [
      'nonhuman release',
      (value) => {
        fixtureRow(value[1])['actor'] = 'agent:synthetic01';
      },
      /event actor/,
    ],
    [
      'blank reason',
      (value) => {
        fixtureRow(value[0])['reason'] = ' ';
      },
      /event reason/,
    ],
    [
      'invalid date',
      (value) => {
        fixtureRow(value[0])['event_on'] = '2029-02-30';
      },
      /event date/,
    ],
    [
      'duplicate kind',
      (value) => {
        fixtureRow(value[1])['kind'] = 'recalled';
      },
      /one event kind per tenant/,
    ],
    [
      'unpaired lot',
      (value) => {
        fixtureRow(value[1])['lot_ref'] = 'lot:synthetic02';
      },
      /paired tenant events/,
    ],
    [
      'missing row',
      (value) => {
        value.pop();
      },
      /exact four mixed events/,
    ],
  ];
  for (const [name, mutate, pattern] of rowMutants) {
    it(`refuses ${name} even with matching file digest before DROP`, async () => {
      const value = rows() as unknown as Record<string, unknown>[];
      mutate(value);
      descriptor = artifact(value);
      await refusesBeforeDrop(pattern);
    });
  }
  it('rereads after observation; a replaced file cannot use a cached valid row array', async () => {
    expect(readEventArtifact(descriptor, binding)).toEqual(rows());
    let calls = 0;
    await expect(
      guardedInverse(
        descriptor,
        expected,
        async () => {
          writeFileSync(descriptor.path, '[]');
          return observed;
        },
        async () => {
          calls++;
        },
      ),
    ).rejects.toThrow(/artifact byte count/);
    expect(calls).toBe(0);
  });
});

async function refusesBeforeInsert(pattern: RegExp): Promise<void> {
  let calls = 0;
  const state = { historical: ['synthetic'], events: [] as ProofEvent[], roles: { safe: true } };
  const before = structuredClone(state);
  await expect(
    guardedRestore(
      descriptor,
      expected,
      async () => observed,
      async (restored) => {
        calls++;
        state.events.push(...restored);
      },
    ),
  ).rejects.toThrow(pattern);
  expect(calls).toBe(0);
  expect(state).toEqual(before);
}

describe('disk descriptor RESTORE preflight INSERT sentinels', () => {
  it('accepts exact bytes and target and calls restore seam once', async () => {
    let calls = 0;
    await guardedRestore(
      descriptor,
      expected,
      async () => observed,
      async (restored) => {
        expect(restored).toEqual(rows());
        calls++;
      },
    );
    expect(calls).toBe(1);
    expect(readEventArtifact(descriptor, binding)).toEqual(rows());
  });
  for (const key of ['cid', 'sid', 'oid', 'database', 'marker', 'owner', 'pgVersion'] as const) {
    it(`refuses observed target ${key} mismatch before INSERT`, async () => {
      observed.target[key] += 'wrong';
      await refusesBeforeInsert(/target identity/);
    });
  }
  it('refuses missing file before INSERT', async () => {
    descriptor = {
      ...descriptor,
      sha256: 'c'.repeat(64),
      path: join(root, `events-${'c'.repeat(64)}.json`),
    };
    await refusesBeforeInsert(/ENOENT/);
  });
  it('refuses same-size corruption before INSERT', async () => {
    const raw = readFileSync(descriptor.path, 'utf8');
    writeFileSync(descriptor.path, raw.replace('human:', 'agent:'));
    await refusesBeforeInsert(/artifact digest/);
  });
  it('refuses truncated bytes before INSERT', async () => {
    writeFileSync(descriptor.path, readFileSync(descriptor.path).subarray(0, 12));
    await refusesBeforeInsert(/artifact byte count/);
  });
  it('refuses wrong declared digest before INSERT', async () => {
    const path = join(root, `events-${'d'.repeat(64)}.json`);
    writeFileSync(path, readFileSync(descriptor.path), { flag: 'wx' });
    descriptor = { ...descriptor, path, sha256: 'd'.repeat(64) };
    await refusesBeforeInsert(/artifact digest/);
  });
  it('refuses invalid JSON with matching digest before INSERT', async () => {
    descriptor = artifact(null, '{invalid JSON');
    await refusesBeforeInsert(/JSON|property name/);
  });
  it('refuses descriptor count mismatch before INSERT', async () => {
    descriptor.count = 3;
    await refusesBeforeInsert(/artifact row count/);
  });
  it('refuses nonabsolute path before INSERT', async () => {
    descriptor.path = 'events.json';
    await refusesBeforeInsert(/owned absolute path/);
  });
  it('refuses path outside owned root before INSERT', async () => {
    descriptor.path = join(resolve(root, '..'), `events-${descriptor.sha256}.json`);
    await refusesBeforeInsert(/owned direct child path/);
  });
  it('refuses directory as artifact before INSERT', async () => {
    descriptor = {
      ...descriptor,
      sha256: 'e'.repeat(64),
      path: join(root, `events-${'e'.repeat(64)}.json`),
    };
    mkdirSync(descriptor.path);
    await refusesBeforeInsert(/regular nonsymlink artifact/);
  });
  it('refuses changed owned-root marker before INSERT', async () => {
    writeFileSync(
      join(root, 'inventory-proof-owner.json'),
      JSON.stringify({ ...binding, artifactOwner: 'another-owner' }),
    );
    await refusesBeforeInsert(/owned root binding/);
  });
  it('refuses source digest binding mismatch before INSERT', async () => {
    descriptor = { ...descriptor, binding: { ...binding, sourceSha256: 'f'.repeat(64) } };
    await refusesBeforeInsert(/artifact binding/);
  });
  for (const field of [
    'schema',
    'owner',
    'columns',
    'constraints',
    'indexes',
    'policies',
    'acl',
    'rls',
    'force',
    'kind',
    'persistence',
  ] as const) {
    it(`refuses altered event catalog ${field} before INSERT`, async () => {
      if (!observed.catalog) throw new Error('Test setup missing catalog');
      observed.catalog[field] = 'mutated';
      await refusesBeforeInsert(/event catalog/);
    });
  }
  it('refuses wrongly bound event owner before INSERT', async () => {
    expected.catalog['owner'] = 'someone_else';
    await refusesBeforeInsert(/event owner\/schema/);
  });
  it('refuses absent event before INSERT', async () => {
    observed.catalog = undefined;
    await refusesBeforeInsert(/event catalog/);
  });
  it('refuses six-table inverse source epoch before INSERT', async () => {
    observed.epoch = 'inventory-0066-six';
    await refusesBeforeInsert(/inverse epoch/);
  });
  it('refuses wrong source epoch binding before INSERT', async () => {
    Object.assign(binding, { sourceEpoch: 'unaccepted' });
    await refusesBeforeInsert(/source\/target epoch/);
  });
  it('refuses absent consumer posture before INSERT', async () => {
    Object.assign(binding, { consumer: undefined });
    await refusesBeforeInsert(/compatible consumer posture/);
  });
  it('refuses incompatible consumer version before INSERT', async () => {
    Object.assign(binding.consumer, { version: 'inventory-0074-seven' });
    await refusesBeforeInsert(/compatible consumer posture/);
  });
  it('refuses changed role posture before INSERT', async () => {
    observed.roles = { safe: false };
    await refusesBeforeInsert(/inverse role posture/);
  });
  const rowMutants: readonly [string, (values: Record<string, unknown>[]) => void, RegExp][] = [
    [
      'nonsynthetic',
      (value) => {
        fixtureRow(value[0])['synthetic'] = false;
      },
      /synthetic tenant\/row/,
    ],
    [
      'unknown tenant',
      (value) => {
        fixtureRow(value[0])['tenant_id'] = 'other-synthetic';
      },
      /synthetic tenant\/row/,
    ],
    [
      'extra key',
      (value) => {
        fixtureRow(value[0])['extra'] = true;
      },
      /exact event keys/,
    ],
    [
      'missing key',
      (value) => {
        delete fixtureRow(value[0])['reason'];
      },
      /exact event keys/,
    ],
    [
      'bad token',
      (value) => {
        fixtureRow(value[0])['recall_ref'] = 'bad';
      },
      /event tokens/,
    ],
    [
      'unknown kind',
      (value) => {
        fixtureRow(value[0])['kind'] = 'unknown';
      },
      /event kind/,
    ],
    [
      'nonhuman release',
      (value) => {
        fixtureRow(value[1])['actor'] = 'agent:synthetic01';
      },
      /event actor/,
    ],
    [
      'blank reason',
      (value) => {
        fixtureRow(value[0])['reason'] = ' ';
      },
      /event reason/,
    ],
    [
      'invalid date',
      (value) => {
        fixtureRow(value[0])['event_on'] = '2029-02-30';
      },
      /event date/,
    ],
    [
      'duplicate kind',
      (value) => {
        fixtureRow(value[1])['kind'] = 'recalled';
      },
      /one event kind per tenant/,
    ],
    [
      'unpaired lot',
      (value) => {
        fixtureRow(value[1])['lot_ref'] = 'lot:synthetic02';
      },
      /paired tenant events/,
    ],
    [
      'missing row',
      (value) => {
        value.pop();
      },
      /exact four mixed events/,
    ],
  ];
  for (const [name, mutate, pattern] of rowMutants) {
    it(`refuses ${name} even with matching file digest before INSERT`, async () => {
      const value = rows() as unknown as Record<string, unknown>[];
      mutate(value);
      descriptor = artifact(value);
      await refusesBeforeInsert(pattern);
    });
  }
  it('rereads after observation; a replaced file cannot use a cached valid row array', async () => {
    expect(readEventArtifact(descriptor, binding)).toEqual(rows());
    let calls = 0;
    await expect(
      guardedRestore(
        descriptor,
        expected,
        async () => {
          writeFileSync(descriptor.path, '[]');
          return observed;
        },
        async () => {
          calls++;
        },
      ),
    ).rejects.toThrow(/artifact byte count/);
    expect(calls).toBe(0);
  });
});

describe('exact root-bound role admission sentinels', () => {
  const posture = (): Awaited<ReturnType<typeof roleProvenance>> => ({
    origin: 'preprovisioned-controlled-fixture',
    version: [{ version: '160004' }],
    roles: ['module_inventory', 'practicehub_app'].map((rolname) => ({
      rolname,
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolcanlogin: false,
      rolinherit: true,
      rolconfig: null,
    })),
    memberships: [
      {
        role: 'module_inventory',
        member: 'practicehub_app',
        grantor: 'proof_owner',
        admin_option: false,
        inherit_option: true,
        set_option: true,
      },
    ],
    settings: [],
    dependencies: [],
    acl: [],
    namespaceAcl: [],
    defaultAcl: [],
  });
  it('admits exact bound posture before invoking fixture creation', () => {
    const value = posture();
    let calls = 0;
    validateRolePosture(value, structuredClone(value));
    calls++;
    expect(calls).toBe(1);
  });
  for (const field of [
    'rolcanlogin',
    'rolcreatedb',
    'rolcreaterole',
    'rolreplication',
    'rolsuper',
    'rolbypassrls',
    'rolinherit',
  ] as const) {
    it(`refuses changed ${field} before fixture SQL`, () => {
      const before = posture();
      const changed = structuredClone(before);
      fixtureRow(changed.roles[0])[field] = !fixtureRow(changed.roles[0])[field];
      let calls = 0;
      expect(() => {
        validateRolePosture(changed, before);
        calls++;
      }).toThrow(/root-bound role posture/);
      expect(calls).toBe(0);
    });
  }
  for (const field of [
    'role',
    'member',
    'grantor',
    'admin_option',
    'inherit_option',
    'set_option',
  ] as const) {
    it(`refuses membership ${field} drift before fixture SQL`, () => {
      const before = posture();
      const changed = structuredClone(before);
      fixtureRow(changed.memberships[0])[field] = 'changed';
      let calls = 0;
      expect(() => {
        validateRolePosture(changed, before);
        calls++;
      }).toThrow(/root-bound role posture/);
      expect(calls).toBe(0);
    });
  }
  it('refuses role setting drift before fixture SQL', () => {
    const before = posture();
    const changed = structuredClone(before);
    changed.settings.push({
      setdatabase: '0',
      setrole: 'module_inventory',
      setconfig: ['search_path=public'],
    });
    let calls = 0;
    expect(() => {
      validateRolePosture(changed, before);
      calls++;
    }).toThrow(/root-bound role posture/);
    expect(calls).toBe(0);
  });
});

describe('restore reread after completed observation', () => {
  for (const fault of ['corrupt', 'remove'] as const) {
    it(`${fault} after valid observation cannot reuse the validated row array`, async () => {
      const cached = readEventArtifact(descriptor, binding);
      expect(cached).toEqual(rows());
      let inserts = 0;
      const before = {
        historical: ['unchanged'],
        events: [] as ProofEvent[],
        roles: { safe: true },
      };
      const state = structuredClone(before);
      await expect(
        guardedRestore(
          descriptor,
          expected,
          async () => {
            if (fault === 'remove') rmSync(descriptor.path);
            else writeFileSync(descriptor.path, '[]');
            return observed;
          },
          async (restored) => {
            inserts++;
            state.events.push(...restored);
          },
        ),
      ).rejects.toThrow(fault === 'remove' ? /ENOENT/ : /artifact byte count/);
      expect(inserts).toBe(0);
      expect(state).toEqual(before);
    });
  }
});

describe('event-only provenance lifecycle comparison', () => {
  type Posture = Awaited<ReturnType<typeof roleProvenance>>;
  function seven(tableOid = '100', indexOid = '101'): Posture {
    return {
      origin: 'preprovisioned-controlled-fixture',
      version: [{ version: '160004' }],
      roles: [{ rolname: 'module_inventory', comment: null, rolconfig: null }],
      memberships: [
        {
          role: 'module_inventory',
          member: 'practicehub_app',
          grantor: 'proof_owner',
          admin_option: false,
          inherit_option: true,
          set_option: true,
        },
      ],
      settings: [],
      namespaceAcl: [{ nspname: 'inventory', nspowner: 'proof_owner', nspacl: null }],
      defaultAcl: [],
      acl: [
        {
          nspname: 'inventory',
          relname: 'lot',
          oid: '90',
          dbid: '42',
          relkind: 'r',
          owner: 'proof_owner',
          index_of: null,
          relacl: 'historical',
          column_acl: [[1, null]],
        },
        {
          nspname: 'inventory',
          relname: 'lot_recall_event',
          oid: tableOid,
          dbid: '42',
          relkind: 'r',
          owner: 'proof_owner',
          index_of: null,
          relacl: 'module-insert-select',
          column_acl: [[1, null]],
        },
        {
          nspname: 'inventory',
          relname: 'lot_recall_event_pkey',
          oid: indexOid,
          dbid: '42',
          relkind: 'i',
          owner: 'proof_owner',
          index_of: 'inventory.lot_recall_event',
          relacl: null,
          column_acl: [[1, null]],
        },
      ],
      dependencies: [
        {
          dbid: '42',
          classid: 'pg_class',
          objid: '90',
          objsubid: 0,
          refclassid: 'pg_authid',
          refobjid: 'module_inventory',
          deptype: 'a',
        },
        {
          dbid: '42',
          classid: 'pg_class',
          objid: tableOid,
          objsubid: 0,
          refclassid: 'pg_authid',
          refobjid: 'module_inventory',
          deptype: 'a',
        },
      ],
    };
  }
  function six(): Posture {
    const value = seven();
    value.acl = value.acl.filter((row) => row['relname'] === 'lot');
    value.dependencies = value.dependencies.filter((row) => row['objid'] === '90');
    return value;
  }
  it('accepts exact event removal and exact event-only table/index OID recreation', () => {
    expect(() => validateEventRoleTransition(seven(), six(), 'inverse')).not.toThrow();
    expect(() =>
      validateEventRoleTransition(seven(), seven('200', '201'), 'reapply'),
    ).not.toThrow();
  });
  const unrelated: readonly [string, (value: Posture) => void][] = [
    [
      'role comment',
      (value) => {
        fixtureRow(value.roles[0])['comment'] = 'unrelated drift';
      },
    ],
    [
      'role setting',
      (value) => {
        value.settings.push({
          setdatabase: '42',
          setrole: 'module_inventory',
          setconfig: ['search_path=public'],
        });
      },
    ],
    [
      'role config',
      (value) => {
        fixtureRow(value.roles[0])['rolconfig'] = ['search_path=public'];
      },
    ],
    [
      'unrelated dependency added',
      (value) => {
        value.dependencies.push({
          dbid: '42',
          classid: 'pg_class',
          objid: '999',
          objsubid: 0,
          refclassid: 'pg_authid',
          refobjid: 'module_inventory',
          deptype: 'a',
        });
      },
    ],
    [
      'unrelated dependency removed',
      (value) => {
        value.dependencies = value.dependencies.filter((row) => row['objid'] !== '90');
      },
    ],
    [
      'unrelated relation ACL',
      (value) => {
        fixtureRow(value.acl[0])['relacl'] = 'changed';
      },
    ],
    [
      'unrelated column ACL',
      (value) => {
        fixtureRow(value.acl[0])['column_acl'] = [[1, 'changed']];
      },
    ],
    [
      'unrelated relation OID',
      (value) => {
        fixtureRow(value.acl[0])['oid'] = '999';
      },
    ],
    [
      'namespace ACL',
      (value) => {
        fixtureRow(value.namespaceAcl[0])['nspacl'] = 'changed';
      },
    ],
    [
      'default ACL',
      (value) => {
        value.defaultAcl.push({
          defaclrole: 'module_inventory',
          defaclnamespace: '0',
          defaclobjtype: 'r',
          defaclacl: 'changed',
        });
      },
    ],
  ];
  for (const phase of ['inverse', 'reapply'] as const) {
    for (const [name, mutate] of unrelated) {
      it(`${phase} refuses ${name} instead of normalizing it away`, () => {
        const changed = phase === 'inverse' ? six() : seven('200', '201');
        mutate(changed);
        expect(() => validateEventRoleTransition(seven(), changed, phase)).toThrow(
          /event-only role provenance transition/,
        );
      });
    }
  }
  it('does not excuse a same-OID dependency in another database during removal', () => {
    const before = seven();
    before.dependencies.push({
      dbid: '99',
      classid: 'pg_class',
      objid: '100',
      objsubid: 0,
      refclassid: 'pg_authid',
      refobjid: 'module_inventory',
      deptype: 'a',
    });
    expect(() => validateEventRoleTransition(before, six(), 'inverse')).toThrow(
      /event-only role provenance transition/,
    );
  });
  for (const delta of [
    { deptype: 'r' },
    { objsubid: 1 },
    { refobjid: 'practicehub_app' },
    { classid: 'pg_proc' },
    { refclassid: 'pg_database' },
  ] as const) {
    it(`does not excuse an unenumerated event dependency ${JSON.stringify(delta)}`, () => {
      const before = seven();
      Object.assign(fixtureRow(before.dependencies[1]), delta);
      expect(() => validateEventRoleTransition(before, six(), 'inverse')).toThrow(
        /event-only role provenance transition/,
      );
    });
  }
  it('reapply cannot change event ACL along with its OID', () => {
    const after = seven('200', '201');
    fixtureRow(after.acl[1])['relacl'] = 'unexpected update';
    expect(() => validateEventRoleTransition(seven(), after, 'reapply')).toThrow(
      /event-only role provenance transition/,
    );
  });
});
