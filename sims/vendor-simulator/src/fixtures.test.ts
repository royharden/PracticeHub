/**
 * Executable fixture packs (WP-027): four classes
 * (HAPPY/BOUNDARY/FAILURE/RECOVERY) per RAIL.
 *
 * WP-027 is a substrate package that owns no canonical requirement end-to-end
 * (the frozen contract §8 delineates the whole REQ-PLAT family to the packages
 * that complete each member), so the four-class floor is applied per rail — the
 * unit of acceptance this package actually delivers.
 *
 * review-009 discipline: the accepted op vocabulary is validated at LOAD time
 * (an unknown op fails the pack's structural test, not silently nothing), and
 * the dispatcher ends in a throwing `default`.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileSimStateStore,
  SimProcessKill,
  VendorSimEngine,
  type RailRequest,
  type RailSim,
} from '@practicehub/vendor-sim-kit';

import { railSimsV1 } from './rails.js';

const fixturesDirectory = resolve(import.meta.dirname, '../fixtures');
const fixtureClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;

const acceptedOps = [
  'arm',
  'dispatch',
  'dispatch-expect-kill',
  'drain-receipts',
  'snapshot',
  'restart',
  'reset',
  // WP-028: the expected-volume heartbeat, exercised per rail alongside its
  // injection story rather than only in the unit suite.
  'record-heartbeat',
  'heartbeat',
] as const;
type FixtureOp = (typeof acceptedOps)[number];

interface FixtureCase {
  readonly op: FixtureOp;
  readonly name: string;
  readonly primitiveId?: string;
  /** Caller-supplied instant for ops that carry one but drive no request. */
  readonly at?: string;
  readonly options?: Record<string, unknown>;
  readonly request?: {
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly payloadRef: string;
    readonly requestedAt: string;
    readonly payload?: unknown;
  };
  readonly expect?: Record<string, unknown>;
}

interface FixturePack {
  readonly synthetic: true;
  readonly railId: string;
  readonly class: (typeof fixtureClasses)[number];
  readonly description: string;
  readonly cases: readonly FixtureCase[];
}

/** Load-time validation: an op the harness does not implement fails HERE. */
function assertKnownOps(pack: FixturePack, label: string): void {
  for (const [index, fixtureCase] of pack.cases.entries()) {
    if (!(acceptedOps as readonly string[]).includes(fixtureCase.op)) {
      throw new Error(
        `${label} case ${index} declares op ${JSON.stringify(fixtureCase.op)}, which the harness does not implement`,
      );
    }
  }
}

function loadPack(railId: string, fixtureClass: string): FixturePack {
  const label = `${railId}.${fixtureClass}`;
  const pack = JSON.parse(
    readFileSync(join(fixturesDirectory, `${label}.json`), 'utf8'),
  ) as FixturePack;
  assertKnownOps(pack, label);
  return pack;
}

const temporaryDirectories: string[] = [];

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'vendor-sim-fixtures-'));
  temporaryDirectories.push(directory);
  return join(directory, 'state.json');
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function requestFrom(rail: RailSim, fixtureCase: FixtureCase): RailRequest {
  const request = fixtureCase.request;
  if (request === undefined) {
    throw new Error(`case ${fixtureCase.name} needs a request`);
  }
  return {
    railId: rail.railId,
    operation: request.operation,
    idempotencyKey: request.idempotencyKey,
    payloadRef: request.payloadRef,
    requestedAt: request.requestedAt,
    ...(request.payload === undefined ? {} : { payload: request.payload }),
    synthetic: true,
  };
}

function runPack(rail: RailSim, pack: FixturePack): void {
  const path = statePath();
  let engine = new VendorSimEngine({ rails: [rail], store: new FileSimStateStore(path) });

  for (const fixtureCase of pack.cases) {
    const expected = fixtureCase.expect ?? {};
    switch (fixtureCase.op) {
      case 'arm': {
        engine.controller.armScenario({
          railId: rail.railId,
          primitiveId: fixtureCase.primitiveId ?? '',
          dataPolicy: 'synthetic-only',
          ...(fixtureCase.options === undefined ? {} : { options: fixtureCase.options }),
        });
        break;
      }
      case 'dispatch': {
        const response = engine.dispatch(requestFrom(rail, fixtureCase));
        for (const [field, value] of Object.entries(expected)) {
          switch (field) {
            case 'receiptRef':
              expect(response.receiptRef === null ? 'absent' : 'present', fixtureCase.name).toBe(
                value,
              );
              break;
            case 'duplicateOf':
              expect(response.duplicateOf === null ? 'absent' : 'present', fixtureCase.name).toBe(
                value,
              );
              break;
            case 'vendorVersionDrifted':
              expect(response.vendorVersion !== rail.pinnedVendorVersion, fixtureCase.name).toBe(
                value,
              );
              break;
            default:
              expect(
                response[field as keyof typeof response],
                `${fixtureCase.name}: ${field}`,
              ).toBe(value);
          }
        }
        // Structural in every case, whatever the fixture asserts.
        expect(response.resendsExternalEffect).toBe(false);
        break;
      }
      case 'dispatch-expect-kill': {
        expect(() => engine.dispatch(requestFrom(rail, fixtureCase)), fixtureCase.name).toThrow(
          SimProcessKill,
        );
        break;
      }
      case 'drain-receipts': {
        const drained = engine.drainReceipts(rail.railId);
        if (expected.kinds !== undefined) {
          expect(
            drained.map((receipt) => receipt.kind),
            fixtureCase.name,
          ).toEqual(expected.kinds);
        }
        if (expected.sequences !== undefined) {
          expect(
            drained.map((receipt) => receipt.sequence),
            fixtureCase.name,
          ).toEqual(expected.sequences);
        }
        break;
      }
      case 'snapshot': {
        const snapshot = engine.snapshot();
        if (expected.effects !== undefined) {
          expect(snapshot.effects.length, `${fixtureCase.name}: effects`).toBe(expected.effects);
        }
        if (expected.receipts !== undefined) {
          expect(snapshot.receipts.length, `${fixtureCase.name}: receipts`).toBe(expected.receipts);
        }
        if (expected.effectState !== undefined) {
          expect(snapshot.effects[0]?.state, `${fixtureCase.name}: state`).toBe(
            expected.effectState,
          );
        }
        break;
      }
      case 'restart': {
        // A restarted process: new engine, new store instance, same file. The
        // armed scenario dies with the process; the ledger does not.
        engine = new VendorSimEngine({ rails: [rail], store: new FileSimStateStore(path) });
        expect(engine.controller.listArmed(), fixtureCase.name).toHaveLength(0);
        break;
      }
      case 'reset': {
        engine.reset();
        break;
      }
      case 'record-heartbeat': {
        engine.recordHeartbeat(rail.railId, fixtureCase.at ?? '2026-01-01T00:00:00Z');
        break;
      }
      case 'heartbeat': {
        const evaluation = engine.heartbeatSweep()[0];
        expect(evaluation?.railId, fixtureCase.name).toBe(rail.railId);
        if (expected.verdict !== undefined) {
          expect(evaluation?.verdict, `${fixtureCase.name}: verdict`).toBe(expected.verdict);
        }
        if (expected.reasons !== undefined) {
          expect(evaluation?.reasons, `${fixtureCase.name}: reasons`).toEqual(expected.reasons);
        }
        if (expected.reasonsInclude !== undefined) {
          for (const reason of expected.reasonsInclude as readonly string[]) {
            expect(evaluation?.reasons, `${fixtureCase.name}: reasons`).toContain(reason);
          }
        }
        break;
      }
      default: {
        const unreachable: never = fixtureCase.op;
        throw new Error(`unhandled fixture op ${JSON.stringify(unreachable)}`);
      }
    }
  }
}

describe('rail fixture packs — four classes per rail', () => {
  it('every rail carries the full four-class floor and nothing else', () => {
    const files = readdirSync(fixturesDirectory)
      .filter((file) => file.endsWith('.json'))
      .sort();
    const expectedFiles = railSimsV1
      .flatMap((rail) => fixtureClasses.map((entry) => `${rail.railId}.${entry}.json`))
      .sort();
    expect(files).toEqual(expectedFiles);
  });

  for (const rail of railSimsV1) {
    for (const fixtureClass of fixtureClasses) {
      it(`${rail.railId} ${fixtureClass}`, () => {
        const pack = loadPack(rail.railId, fixtureClass);
        expect(pack.synthetic).toBe(true);
        expect(pack.railId).toBe(rail.railId);
        expect(pack.class).toBe(fixtureClass);
        expect(pack.cases.length).toBeGreaterThan(0);
        runPack(rail, pack);
      });
    }
  }

  it('refuses a pack whose case names an op the harness does not implement', () => {
    const rogue = {
      synthetic: true,
      railId: 'RAIL-008',
      class: 'HAPPY',
      description: 'a pack authored against a harness that does not exist',
      cases: [{ op: 'frobnicate' as FixtureOp, name: 'unknown-op' }],
    } as const satisfies FixturePack;
    expect(() => assertKnownOps(rogue, 'rogue.HAPPY')).toThrow(
      /declares op "frobnicate", which the harness does not implement/,
    );
  });
});
