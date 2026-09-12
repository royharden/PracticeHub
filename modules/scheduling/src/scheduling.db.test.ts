import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const config = {
  host: process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1',
  port: Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432'),
  database: 'practicehub',
};
const ownerConfig = {
  ...config,
  user: 'practicehub',
  password: 'practicehub_synthetic_local',
};
const appConfig = {
  ...config,
  user: 'practicehub_app',
  password: 'practicehub_app_synthetic_local',
};
let owner: Client;
let app: Client;

async function migrate(): Promise<void> {
  await owner.query(readFileSync(`${repoRoot}infra/postgres/init/001-bootstrap.sql`, 'utf8'));
  await owner.query(
    readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
  );
  await owner.query(
    readFileSync(`${repoRoot}infra/postgres/migrations/0032-scheduling.sql`, 'utf8'),
  );
  await owner.query(readFileSync(`${repoRoot}infra/postgres/seed/003-tenancy-seed.sql`, 'utf8'));
  await owner.query(readFileSync(`${repoRoot}infra/postgres/seed/031-scheduling-seed.sql`, 'utf8'));
}

async function begin(client: Client, tenantId = 'northwind-synthetic'): Promise<void> {
  await client.query('BEGIN');
  await client.query(tenantBindingSql(tenantId));
}

async function createOfferAndHold(
  client: Client,
  suffix: string,
  patientId: string,
  range: string,
): Promise<void> {
  await client.query(`INSERT INTO sched.slot_offer
    (tenant_id,slot_offer_id,location_id,provider_id,service_id,required_resource_ids,
     slot_range,constraint_bundle_id,constraint_bundle_version,policy_snapshot_id,
     source_version,adapter_id,adapter_mode,expires_at,synthetic)
    VALUES ('northwind-synthetic','offer-${suffix}','location-${suffix}',
      'provider-synthetic-1','routine-visit',ARRAY['room-synthetic-1'],${range},
      'routine-visit',1,'accepting-v1',1,'wp032-athena-scheduling-double/v1',
      'synthetic','2099-01-01T01:00:00Z',true)`);
  await client.query(`INSERT INTO sched.slot_hold
    (tenant_id,hold_id,slot_offer_id,patient_id,idempotency_key,input_hash,state,
     authority_epoch,source_version,expires_at,created_at,synthetic)
    VALUES ('northwind-synthetic','hold-${suffix}','offer-${suffix}','${patientId}',
      'idem-${suffix}','${'a'.repeat(64)}','live',1,1,
      '2099-01-01T01:00:00Z','2099-01-01T00:00:00Z',true)`);
}

async function addReservation(
  client: Client,
  suffix: string,
  kind: 'provider' | 'patient' | 'resource',
  subjectId: string,
  range: string,
): Promise<void> {
  await client.query(`INSERT INTO sched.resource_reservation
    (tenant_id,reservation_id,subject_kind,subject_id,reservation_range,state,
     hold_id,created_at,synthetic)
    VALUES ('northwind-synthetic','reservation-${suffix}-${kind}', '${kind}',
      '${subjectId}',${range},'held','hold-${suffix}','2099-01-01T00:00:00Z',true)`);
}

const tenant = 'northwind-synthetic';

type SubjectKind = 'provider' | 'patient' | 'resource';

interface Booking {
  readonly suffix: string;
  readonly locationId: string;
  readonly providerId: string;
  readonly patientId: string;
  readonly resourceIds: readonly string[];
  readonly range: string;
}

function halfOpen(start: string, end: string): string {
  return `[${start},${end})`;
}

function subjectsOf(booking: Booking): { kind: SubjectKind; id: string }[] {
  return [
    { kind: 'provider', id: booking.providerId },
    { kind: 'patient', id: booking.patientId },
    ...booking.resourceIds.map((id) => ({ kind: 'resource' as const, id })),
  ];
}

async function connectOwner(): Promise<Client> {
  const client = new Client(ownerConfig);
  await client.connect();
  return client;
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query('SELECT pg_backend_pid() AS pid');
  return Number(result.rows[0]?.['pid']);
}

async function countRows(
  client: Client,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const result = await client.query(sql, [...params]);
  return Number(result.rows[0]?.['n']);
}

// Barrier: resolves only once `pid` is queued behind another transaction's lock, so
// both clients are provably at the collision boundary before the first commits.
async function waitUntilLockWaiting(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = await owner.query(
      'SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted LIMIT 1',
      [pid],
    );
    if ((waiting.rowCount ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`backend ${pid} never reached a lock wait`);
}

async function advisoryLockGranted(pid: number, key: string): Promise<boolean> {
  const granted = await countRows(
    owner,
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE pid = $1 AND locktype = 'advisory' AND granted AND objsubid = 1
        AND classid = ((hashtextextended($2, 0) >> 32) & 4294967295)::oid
        AND objid = (hashtextextended($2, 0) & 4294967295)::oid`,
    [pid, key],
  );
  return granted === 1;
}

async function insertHold(
  client: Client,
  booking: Booking,
  expiresAt = '2099-12-31T00:00:00Z',
): Promise<void> {
  await client.query(
    `INSERT INTO sched.slot_offer
      (tenant_id,slot_offer_id,location_id,provider_id,service_id,required_resource_ids,
       slot_range,constraint_bundle_id,constraint_bundle_version,policy_snapshot_id,
       source_version,adapter_id,adapter_mode,expires_at,synthetic)
     VALUES ($1,$2,$3,$4,'routine-visit',$5::text[],$6::tstzrange,'routine-visit',1,
       'accepting-v1',1,'wp032-athena-scheduling-double/v1','synthetic',$7,true)`,
    [
      tenant,
      `offer-${booking.suffix}`,
      booking.locationId,
      booking.providerId,
      [...booking.resourceIds],
      booking.range,
      expiresAt,
    ],
  );
  await client.query(
    `INSERT INTO sched.slot_hold
      (tenant_id,hold_id,slot_offer_id,patient_id,idempotency_key,input_hash,state,
       authority_epoch,source_version,expires_at,created_at,synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,'live',1,1,$7,'2099-01-01T00:00:00Z',true)`,
    [
      tenant,
      `hold-${booking.suffix}`,
      `offer-${booking.suffix}`,
      booking.patientId,
      `idem-${booking.suffix}`,
      'b'.repeat(64),
      expiresAt,
    ],
  );
  for (const subject of subjectsOf(booking)) {
    await client.query(
      `INSERT INTO sched.resource_reservation
        (tenant_id,reservation_id,subject_kind,subject_id,reservation_range,state,
         hold_id,created_at,synthetic)
       VALUES ($1,$2,$3,$4,$5::tstzrange,'held',$6,'2099-01-01T00:00:00Z',true)`,
      [
        tenant,
        `reservation-${booking.suffix}-${subject.kind}-${subject.id}`,
        subject.kind,
        subject.id,
        booking.range,
        `hold-${booking.suffix}`,
      ],
    );
  }
}

async function insertAppointmentRow(
  client: Client,
  booking: Booking,
  predecessorAppointmentId: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO sched.appointment
      (tenant_id,appointment_id,patient_id,location_id,provider_id,service_id,resource_ids,
       appointment_range,state,version,authority_epoch,source_version,
       predecessor_appointment_id,created_at,synthetic)
     VALUES ($1,$2,$3,$4,$5,'routine-visit',$6::text[],$7::tstzrange,'booked',1,1,1,$8,
       '2099-01-01T00:00:00Z',true)`,
    [
      tenant,
      `appointment-${booking.suffix}`,
      booking.patientId,
      booking.locationId,
      booking.providerId,
      [...booking.resourceIds],
      booking.range,
      predecessorAppointmentId,
    ],
  );
}

async function insertAppointment(
  client: Client,
  booking: Booking,
  predecessorAppointmentId: string | null = null,
): Promise<void> {
  await insertAppointmentRow(client, booking, predecessorAppointmentId);
  for (const subject of subjectsOf(booking)) {
    await client.query(
      `INSERT INTO sched.resource_reservation
        (tenant_id,reservation_id,subject_kind,subject_id,reservation_range,state,
         appointment_id,created_at,synthetic)
       VALUES ($1,$2,$3,$4,$5::tstzrange,'booked',$6,'2099-01-01T00:00:00Z',true)`,
      [
        tenant,
        `reservation-${booking.suffix}-${subject.kind}-${subject.id}`,
        subject.kind,
        subject.id,
        booking.range,
        `appointment-${booking.suffix}`,
      ],
    );
  }
}

async function lockSubjects(client: Client, bookings: readonly Booking[]): Promise<void> {
  await client.query('SELECT sched.lock_reservation_subjects($1, $2::jsonb)', [
    tenant,
    JSON.stringify(bookings.flatMap(subjectsOf)),
  ]);
}

// Converts a live hold into an appointment. With rebindAll false, the resource
// reservations are deliberately left on the hold to prove the set is all-or-nothing.
async function convertHold(client: Client, booking: Booking, rebindAll: boolean): Promise<void> {
  await lockSubjects(client, [booking]);
  await insertAppointmentRow(client, booking);
  await client.query(
    `UPDATE sched.resource_reservation
        SET hold_id = NULL, appointment_id = $3, state = 'booked'
      WHERE tenant_id = $1 AND hold_id = $2
        ${rebindAll ? '' : "AND subject_kind <> 'resource'"}`,
    [tenant, `hold-${booking.suffix}`, `appointment-${booking.suffix}`],
  );
  await client.query(
    `UPDATE sched.slot_hold SET state = 'converted'
      WHERE tenant_id = $1 AND hold_id = $2 AND state = 'live'`,
    [tenant, `hold-${booking.suffix}`],
  );
}

async function reschedule(client: Client, original: Booking, replacement: Booking): Promise<void> {
  await lockSubjects(client, [original, replacement]);
  await client.query(
    `UPDATE sched.appointment SET state = 'superseded', version = version + 1
      WHERE tenant_id = $1 AND appointment_id = $2 AND state = 'booked'`,
    [tenant, `appointment-${original.suffix}`],
  );
  await client.query(
    `UPDATE sched.resource_reservation SET state = 'cancelled'
      WHERE tenant_id = $1 AND appointment_id = $2 AND state = 'booked'`,
    [tenant, `appointment-${original.suffix}`],
  );
  await insertAppointment(client, replacement, `appointment-${original.suffix}`);
}

async function expectExactlyOneWinner(
  claimFirst: (client: Client) => Promise<void>,
  claimSecond: (client: Client) => Promise<void>,
): Promise<void> {
  const first = await connectOwner();
  const second = await connectOwner();
  try {
    await begin(first);
    await begin(second);
    await claimFirst(first);
    const secondPid = await backendPid(second);
    const secondOutcome = claimSecond(second).then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitUntilLockWaiting(secondPid);
    await first.query('COMMIT');
    expect(await secondOutcome).toMatchObject({ code: '23P01' });
    await second.query('ROLLBACK');
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    await first.end();
    await second.end();
  }
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  await migrate();
  app = new Client(appConfig);
  await app.connect();
}, 60_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('scheduling database acceptance boundary', () => {
  it('allows exactly one of two clients to reserve an overlapping provider', async () => {
    const first = new Client(ownerConfig);
    const second = new Client(ownerConfig);
    await first.connect();
    await second.connect();
    const range = `tstzrange('2099-01-01T00:00:00Z','2099-01-01T00:30:00Z','[)')`;
    try {
      await begin(first);
      await begin(second);
      await createOfferAndHold(first, 'race-a', 'patient-a', range);
      await createOfferAndHold(second, 'race-b', 'patient-b', range);
      await addReservation(first, 'race-a', 'patient', 'patient-a', range);
      await addReservation(first, 'race-a', 'resource', 'room-synthetic-1', range);
      await addReservation(first, 'race-a', 'provider', 'provider-synthetic-1', range);
      await addReservation(second, 'race-b', 'patient', 'patient-b', range);
      const blocked = addReservation(second, 'race-b', 'provider', 'provider-synthetic-1', range);
      await first.query('COMMIT');
      await expect(blocked).rejects.toMatchObject({ code: '23P01' });
      await second.query('ROLLBACK');
      const count = await owner.query(
        `SELECT count(*)::int AS n FROM sched.resource_reservation
          WHERE tenant_id='northwind-synthetic' AND subject_kind='provider'
            AND subject_id='provider-synthetic-1' AND state='held'`,
      );
      expect(count.rows[0]?.['n']).toBe(1);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      await first.end();
      await second.end();
    }
  });

  it('rejects a live hold with a missing reservation set at the deferred boundary', async () => {
    await begin(owner);
    try {
      await createOfferAndHold(
        owner,
        'missing',
        'patient-missing',
        `tstzrange('2099-01-02T00:00:00Z','2099-01-02T00:30:00Z','[)')`,
      );
      await expect(owner.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(
        /reservation_set_incomplete/,
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('rejects infinite bounds and cross-tenant writes', async () => {
    await begin(owner);
    try {
      await expect(
        owner.query(`INSERT INTO sched.slot_offer
          (tenant_id,slot_offer_id,location_id,provider_id,service_id,required_resource_ids,
           slot_range,constraint_bundle_id,constraint_bundle_version,policy_snapshot_id,
           source_version,adapter_id,adapter_mode,expires_at,synthetic)
          VALUES ('northwind-synthetic','offer-infinite','location-1','provider-synthetic-1',
            'routine-visit',ARRAY['room-synthetic-1'],
            tstzrange('2099-01-01T00:00:00Z','infinity','[)'),
            'routine-visit',1,'accepting-v1',1,'wp032-athena-scheduling-double/v1',
            'synthetic','2099-01-01T01:00:00Z',true)`),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await owner.query('ROLLBACK');
    }

    await app.query('BEGIN');
    try {
      await app.query(tenantBindingSql('northwind-synthetic'));
      await expect(
        app.query(`SELECT * FROM sched.resource WHERE tenant_id='riverbend-synthetic'`),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        app.query(`INSERT INTO sched.resource
          (tenant_id,resource_id,resource_type,source_version,active,synthetic)
          VALUES ('riverbend-synthetic','forged','room',1,true,true)`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('lets only one of two clients hold the same patient at different locations', async () => {
    const range = halfOpen('2099-02-01T00:00:00Z', '2099-02-01T00:30:00Z');
    const east: Booking = {
      suffix: 'patient-race-east',
      locationId: 'location-east',
      providerId: 'provider-east',
      patientId: 'patient-shared',
      resourceIds: ['room-east'],
      range,
    };
    const west: Booking = {
      ...east,
      suffix: 'patient-race-west',
      locationId: 'location-west',
      providerId: 'provider-west',
      resourceIds: ['room-west'],
    };
    await expectExactlyOneWinner(
      (client) => insertHold(client, east),
      (client) => insertHold(client, west),
    );
    expect(
      await countRows(
        owner,
        `SELECT count(*)::int AS n FROM sched.resource_reservation
          WHERE tenant_id = $1 AND subject_kind = 'patient' AND subject_id = 'patient-shared'
            AND state = 'held'`,
        [tenant],
      ),
    ).toBe(1);
    expect(
      await countRows(
        owner,
        'SELECT count(*)::int AS n FROM sched.resource_reservation WHERE tenant_id = $1 AND hold_id = $2',
        [tenant, 'hold-patient-race-east'],
      ),
    ).toBe(3);
    expect(
      await countRows(
        owner,
        'SELECT count(*)::int AS n FROM sched.slot_hold WHERE tenant_id = $1 AND hold_id = $2',
        [tenant, 'hold-patient-race-west'],
      ),
    ).toBe(0);
  });

  it('lets only one of two clients hold the same exclusive resource', async () => {
    const range = halfOpen('2099-02-02T00:00:00Z', '2099-02-02T00:30:00Z');
    const first: Booking = {
      suffix: 'resource-race-a',
      locationId: 'location-resource',
      providerId: 'provider-resource-a',
      patientId: 'patient-resource-a',
      resourceIds: ['device-shared'],
      range,
    };
    const second: Booking = {
      ...first,
      suffix: 'resource-race-b',
      providerId: 'provider-resource-b',
      patientId: 'patient-resource-b',
    };
    await expectExactlyOneWinner(
      (client) => insertHold(client, first),
      (client) => insertHold(client, second),
    );
    expect(
      await countRows(
        owner,
        `SELECT count(*)::int AS n FROM sched.resource_reservation
          WHERE tenant_id = $1 AND subject_kind = 'resource' AND subject_id = 'device-shared'
            AND state = 'held'`,
        [tenant],
      ),
    ).toBe(1);
    expect(
      await countRows(
        owner,
        'SELECT count(*)::int AS n FROM sched.slot_hold WHERE tenant_id = $1 AND hold_id = $2',
        [tenant, 'hold-resource-race-b'],
      ),
    ).toBe(0);
  });

  it('refuses a hold that overlaps a booking but admits the adjacent interval', async () => {
    const booked: Booking = {
      suffix: 'overlap-booked',
      locationId: 'location-overlap',
      providerId: 'provider-overlap',
      patientId: 'patient-overlap-booked',
      resourceIds: ['room-overlap-booked'],
      range: halfOpen('2099-02-03T00:00:00Z', '2099-02-03T00:30:00Z'),
    };
    const overlapping: Booking = {
      ...booked,
      suffix: 'overlap-held',
      patientId: 'patient-overlap-held',
      resourceIds: ['room-overlap-held'],
      range: halfOpen('2099-02-03T00:15:00Z', '2099-02-03T00:45:00Z'),
    };
    await expectExactlyOneWinner(
      (client) => insertAppointment(client, booked),
      (client) => insertHold(client, overlapping),
    );
    const providerRows = `SELECT count(*)::int AS n FROM sched.resource_reservation
      WHERE tenant_id = $1 AND subject_kind = 'provider' AND subject_id = 'provider-overlap'
        AND state = $2`;
    expect(await countRows(owner, providerRows, [tenant, 'booked'])).toBe(1);
    expect(await countRows(owner, providerRows, [tenant, 'held'])).toBe(0);

    const adjacent: Booking = {
      ...booked,
      suffix: 'overlap-adjacent',
      patientId: 'patient-overlap-adjacent',
      resourceIds: ['room-overlap-adjacent'],
      range: halfOpen('2099-02-03T00:30:00Z', '2099-02-03T01:00:00Z'),
    };
    await begin(owner);
    await insertHold(owner, adjacent);
    await owner.query('COMMIT');
    expect(await countRows(owner, providerRows, [tenant, 'held'])).toBe(1);
  });

  it('acquires reservation-subject locks in sorted order regardless of input order', async () => {
    const holder = await connectOwner();
    const locker = await connectOwner();
    const providerKey = `${tenant}|provider|provider-order`;
    const resourceKey = `${tenant}|resource|room-order`;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [resourceKey]);
      await locker.query('BEGIN');
      const lockerPid = await backendPid(locker);
      // Input lists the resource first; sorted order takes the provider first.
      const outcome = locker
        .query('SELECT sched.lock_reservation_subjects($1, $2::jsonb)', [
          tenant,
          JSON.stringify([
            { kind: 'resource', id: 'room-order' },
            { kind: 'provider', id: 'provider-order' },
          ]),
        ])
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await waitUntilLockWaiting(lockerPid);
      expect(await advisoryLockGranted(lockerPid, providerKey)).toBe(true);
      expect(await advisoryLockGranted(lockerPid, resourceKey)).toBe(false);
      await holder.query('COMMIT');
      expect(await outcome).toBeUndefined();
      expect(await advisoryLockGranted(lockerPid, resourceKey)).toBe(true);
      await locker.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await locker.query('ROLLBACK').catch(() => undefined);
      await holder.end();
      await locker.end();
    }
  });

  it('makes begin_effect idempotent and refuses payload, scope and tenant drift', async () => {
    const effectRange = halfOpen('2099-03-01T00:00:00Z', '2099-03-01T00:30:00Z');
    const beginEffect = (options: {
      key: string;
      identity: string;
      inputHash?: string;
      resources?: readonly string[];
      tenantId?: string;
    }) =>
      app.query(
        `SELECT sched.begin_effect($1,$2,'holdSlot',$3,$4,1,1,true,
           'provider-effect','patient-effect',$5::text[],$6::tstzrange) AS state`,
        [
          options.tenantId ?? tenant,
          options.key,
          options.inputHash ?? 'c'.repeat(64),
          options.identity,
          [...(options.resources ?? ['room-effect'])],
          effectRange,
        ],
      );
    const expectRefused = async (
      label: string,
      attempt: () => Promise<unknown>,
      expected: RegExp | { code: string },
    ): Promise<void> => {
      await app.query(`SAVEPOINT ${label}`);
      if (expected instanceof RegExp) {
        await expect(attempt()).rejects.toThrow(expected);
      } else {
        await expect(attempt()).rejects.toMatchObject(expected);
      }
      await app.query(`ROLLBACK TO SAVEPOINT ${label}`);
    };
    const scopeRows = `SELECT count(*)::int AS n FROM sched.command_effect_scope
      WHERE tenant_id = $1 AND idempotency_key = $2 AND state = $3`;

    await begin(app);
    try {
      const first = await beginEffect({ key: 'effect-key-1', identity: 'effect-identity-1' });
      expect(first.rows[0]?.['state']).toBe('pending');
      const retry = await beginEffect({ key: 'effect-key-1', identity: 'effect-identity-1' });
      expect(retry.rows[0]?.['state']).toBe('pending');
      expect(
        await countRows(
          app,
          'SELECT count(*)::int AS n FROM sched.command_effect WHERE tenant_id = $1 AND idempotency_key = $2',
          [tenant, 'effect-key-1'],
        ),
      ).toBe(1);
      expect(await countRows(app, scopeRows, [tenant, 'effect-key-1', 'pending'])).toBe(3);

      await expectRefused(
        'payload_drift',
        () =>
          beginEffect({
            key: 'effect-key-1',
            identity: 'effect-identity-1',
            inputHash: 'd'.repeat(64),
          }),
        /effect_idempotency_payload_drift/,
      );
      await expectRefused(
        'scope_drift',
        () =>
          beginEffect({
            key: 'effect-key-1',
            identity: 'effect-identity-1',
            resources: ['room-effect', 'room-effect-extra'],
          }),
        /effect_scope_drift/,
      );
      await expectRefused(
        'scope_fence',
        () => beginEffect({ key: 'effect-key-2', identity: 'effect-identity-2' }),
        { code: '23P01' },
      );
      await expectRefused(
        'tenant_drift',
        () =>
          beginEffect({
            key: 'effect-key-3',
            identity: 'effect-identity-3',
            tenantId: 'riverbend-synthetic',
          }),
        /effect_tenant_scope_mismatch/,
      );

      await app.query(
        `SELECT sched.complete_effect($1, 'effect-key-1', 'receipt-effect-1', '{"ok":true}'::jsonb)`,
        [tenant],
      );
      expect(await countRows(app, scopeRows, [tenant, 'effect-key-1', 'closed'])).toBe(3);
      const next = await beginEffect({ key: 'effect-key-2', identity: 'effect-identity-2' });
      expect(next.rows[0]?.['state']).toBe('pending');
      expect(
        await countRows(
          app,
          'SELECT count(*)::int AS n FROM sched.command_effect WHERE tenant_id = $1',
          [tenant],
        ),
      ).toBe(2);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('expires a hold and releases its reservations in one transaction', async () => {
    const booking: Booking = {
      suffix: 'expiry',
      locationId: 'location-expiry',
      providerId: 'provider-expiry',
      patientId: 'patient-expiry',
      resourceIds: ['room-expiry'],
      range: halfOpen('2099-04-01T01:00:00Z', '2099-04-01T01:30:00Z'),
    };
    await begin(owner);
    await insertHold(owner, booking, '2099-04-01T00:10:00Z');
    await owner.query('COMMIT');
    const expire = (observedAt: string) =>
      app.query('SELECT sched.expire_hold($1, $2, $3::timestamptz) AS expired', [
        tenant,
        'hold-expiry',
        observedAt,
      ]);
    const holdRows = `SELECT count(*)::int AS n FROM sched.slot_hold
      WHERE tenant_id = $1 AND hold_id = 'hold-expiry' AND state = $2`;
    const reservationRows = `SELECT count(*)::int AS n FROM sched.resource_reservation
      WHERE tenant_id = $1 AND hold_id = 'hold-expiry' AND state = $2`;

    await begin(app);
    try {
      expect((await expire('2099-04-01T00:05:00Z')).rows[0]?.['expired']).toBe(false);
    } finally {
      await app.query('ROLLBACK');
    }
    await begin(app, 'riverbend-synthetic');
    try {
      await expect(expire('2099-04-01T00:20:00Z')).rejects.toThrow(/hold_tenant_scope_mismatch/);
    } finally {
      await app.query('ROLLBACK');
    }
    expect(await countRows(owner, holdRows, [tenant, 'live'])).toBe(1);
    expect(await countRows(owner, reservationRows, [tenant, 'held'])).toBe(3);

    await begin(app);
    expect((await expire('2099-04-01T00:20:00Z')).rows[0]?.['expired']).toBe(true);
    await app.query('COMMIT');
    expect(await countRows(owner, holdRows, [tenant, 'expired'])).toBe(1);
    expect(await countRows(owner, reservationRows, [tenant, 'expired'])).toBe(3);
    expect(await countRows(owner, reservationRows, [tenant, 'held'])).toBe(0);

    await begin(app);
    try {
      expect((await expire('2099-04-01T00:30:00Z')).rows[0]?.['expired']).toBe(false);
    } finally {
      await app.query('ROLLBACK');
    }
    const successor: Booking = {
      ...booking,
      suffix: 'expiry-successor',
      patientId: 'patient-expiry-successor',
    };
    await begin(owner);
    await insertHold(owner, successor);
    await owner.query('COMMIT');
    expect(
      await countRows(
        owner,
        `SELECT count(*)::int AS n FROM sched.resource_reservation
          WHERE tenant_id = $1 AND subject_kind = 'provider' AND subject_id = 'provider-expiry'
            AND state = 'held'`,
        [tenant],
      ),
    ).toBe(1);
  });

  it('converts a hold into an appointment atomically, or not at all', async () => {
    const booking: Booking = {
      suffix: 'convert',
      locationId: 'location-convert',
      providerId: 'provider-convert',
      patientId: 'patient-convert',
      resourceIds: ['room-convert', 'device-convert'],
      range: halfOpen('2099-05-01T00:00:00Z', '2099-05-01T00:30:00Z'),
    };
    await begin(owner);
    await insertHold(owner, booking);
    await owner.query('COMMIT');
    const appointmentRows = `SELECT count(*)::int AS n FROM sched.appointment
      WHERE tenant_id = $1 AND appointment_id = 'appointment-convert' AND state = 'booked'`;
    const holdReservations = `SELECT count(*)::int AS n FROM sched.resource_reservation
      WHERE tenant_id = $1 AND hold_id = 'hold-convert' AND state = 'held'`;
    const appointmentReservations = `SELECT count(*)::int AS n FROM sched.resource_reservation
      WHERE tenant_id = $1 AND appointment_id = 'appointment-convert' AND state = 'booked'`;
    const holdState = `SELECT count(*)::int AS n FROM sched.slot_hold
      WHERE tenant_id = $1 AND hold_id = 'hold-convert' AND state = $2`;

    await begin(owner);
    await convertHold(owner, booking, false);
    await expect(owner.query('COMMIT')).rejects.toThrow(/reservation_set_incomplete/);
    expect(await countRows(owner, appointmentRows, [tenant])).toBe(0);
    expect(await countRows(owner, holdReservations, [tenant])).toBe(4);
    expect(await countRows(owner, holdState, [tenant, 'live'])).toBe(1);

    await begin(owner);
    await convertHold(owner, booking, true);
    await owner.query('COMMIT');
    expect(await countRows(owner, appointmentRows, [tenant])).toBe(1);
    expect(await countRows(owner, appointmentReservations, [tenant])).toBe(4);
    expect(await countRows(owner, holdReservations, [tenant])).toBe(0);
    expect(await countRows(owner, holdState, [tenant, 'converted'])).toBe(1);
  });

  it('reschedules atomically and leaves the original booked when the replacement fails', async () => {
    const original: Booking = {
      suffix: 'reschedule-original',
      locationId: 'location-reschedule',
      providerId: 'provider-reschedule',
      patientId: 'patient-reschedule',
      resourceIds: ['room-reschedule'],
      range: halfOpen('2099-06-01T00:00:00Z', '2099-06-01T00:30:00Z'),
    };
    const blocker: Booking = {
      ...original,
      suffix: 'reschedule-blocker',
      patientId: 'patient-reschedule-blocker',
      resourceIds: ['room-reschedule-blocker'],
      range: halfOpen('2099-06-01T01:00:00Z', '2099-06-01T01:30:00Z'),
    };
    await begin(owner);
    await insertAppointment(owner, original);
    await insertAppointment(owner, blocker);
    await owner.query('COMMIT');
    const appointmentState = `SELECT count(*)::int AS n FROM sched.appointment
      WHERE tenant_id = $1 AND appointment_id = $2 AND state = $3`;
    const reservationState = `SELECT count(*)::int AS n FROM sched.resource_reservation
      WHERE tenant_id = $1 AND appointment_id = $2 AND state = $3`;

    const conflicting: Booking = {
      ...original,
      suffix: 'reschedule-conflict',
      range: halfOpen('2099-06-01T01:15:00Z', '2099-06-01T01:45:00Z'),
    };
    await begin(owner);
    try {
      await expect(reschedule(owner, original, conflicting)).rejects.toMatchObject({
        code: '23P01',
      });
    } finally {
      await owner.query('ROLLBACK');
    }
    expect(
      await countRows(owner, appointmentState, [
        tenant,
        'appointment-reschedule-original',
        'booked',
      ]),
    ).toBe(1);
    expect(
      await countRows(owner, reservationState, [
        tenant,
        'appointment-reschedule-original',
        'booked',
      ]),
    ).toBe(3);
    expect(
      await countRows(
        owner,
        'SELECT count(*)::int AS n FROM sched.appointment WHERE tenant_id = $1 AND appointment_id = $2',
        [tenant, 'appointment-reschedule-conflict'],
      ),
    ).toBe(0);

    // The replacement overlaps the original's own interval: legal only because the
    // original is superseded and its reservations cancelled in the same transaction.
    const replacement: Booking = {
      ...original,
      suffix: 'reschedule-replacement',
      range: halfOpen('2099-06-01T00:15:00Z', '2099-06-01T00:45:00Z'),
    };
    await begin(owner);
    await reschedule(owner, original, replacement);
    await owner.query('COMMIT');
    expect(
      await countRows(owner, appointmentState, [
        tenant,
        'appointment-reschedule-original',
        'superseded',
      ]),
    ).toBe(1);
    expect(
      await countRows(owner, reservationState, [
        tenant,
        'appointment-reschedule-original',
        'cancelled',
      ]),
    ).toBe(3);
    expect(
      await countRows(owner, reservationState, [
        tenant,
        'appointment-reschedule-original',
        'booked',
      ]),
    ).toBe(0);
    expect(
      await countRows(
        owner,
        `SELECT count(*)::int AS n FROM sched.appointment
          WHERE tenant_id = $1 AND appointment_id = $2 AND state = 'booked'
            AND predecessor_appointment_id = $3`,
        [tenant, 'appointment-reschedule-replacement', 'appointment-reschedule-original'],
      ),
    ).toBe(1);
    expect(
      await countRows(owner, reservationState, [
        tenant,
        'appointment-reschedule-replacement',
        'booked',
      ]),
    ).toBe(3);
  });

  it('rolls back and cleanly reapplies the scheduling schema', async () => {
    await owner.query(
      readFileSync(`${repoRoot}infra/postgres/migrations/0032-scheduling.rollback.sql`, 'utf8'),
    );
    expect(
      (await owner.query(`SELECT to_regclass('sched.slot_hold') AS relation`)).rows[0]?.[
        'relation'
      ],
    ).toBeNull();
    await migrate();
  });
});
