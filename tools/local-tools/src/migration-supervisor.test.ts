import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  createWindowsMigrationSupervisor,
  parseJobFrames,
  nativeEnvironment,
  closeOwnedJob,
  type WindowsSupervisorBinding,
} from './migration-supervisor.js';

const nonce = 'a'.repeat(64);
const owned = `PHJOB:${nonce}:owned:42:133000000000000001:1:259`;
const released = `PHJOB:${nonce}:released:42:133000000000000001:0:0`;
describe('owned cancellation close deadline controls', () => {
  it('pipe write success followed by never-close attempts exact held cleanup and retains UNKNOWN', async () => {
    const write = vi.fn(async () => {});
    const held = vi.fn();
    const unrelated = vi.fn();
    const operation = closeOwnedJob(write, new Promise<number | null>(() => {}), held, 5);
    await expect(operation).rejects.toThrow(/UNKNOWN/);
    expect(write).toHaveBeenCalledOnce();
    expect(held).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
  });
  it('retains the original pipe failure even when held termination and final wait fail', async () => {
    const cause = new Error('original pipe cause');
    const kill = new Error('held termination failure');
    let failure: unknown;
    try {
      await closeOwnedJob(
        async () => {
          throw cause;
        },
        new Promise<number | null>(() => {}),
        () => {
          throw kill;
        },
        5,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(cause);
    expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([cause, kill]));
  });
  it('admits a completed owned close without invoking termination', async () => {
    const terminate = vi.fn();
    await expect(closeOwnedJob(async () => {}, Promise.resolve(0), terminate, 10)).resolves.toBe(0);
    expect(terminate).not.toHaveBeenCalled();
  });
});
describe('native job protocol negative controls', () => {
  it('requires matching PID and creation FILETIME plus active-zero receipt', () => {
    expect(parseJobFrames(`${owned}\nordinary stderr\n${released}\n`, nonce)).toEqual({
      pid: 42,
      created: '133000000000000001',
      exitCode: 0,
    });
  });
  it.each([
    ['missing', owned],
    ['reused PID', `${owned}\n${released.replace('133000000000000001', '133000000000000002')}`],
    ['wrong PID', `${owned}\n${released.replace(':42:', ':43:')}`],
    ['wrong nonce', `${owned}\n${released.replace(nonce, 'b'.repeat(64))}`],
    ['still active', `${owned}\n${released.replace(':0:0', ':1:0')}`],
    ['UNKNOWN', `${owned}\nPHJOB:${nonce}:unknown:Win32Exception`],
    ['duplicate', `${owned}\n${released}\n${released}`],
    ['no owned receipt', released],
  ])('rejects %s', (_name, text) => {
    expect(() => parseJobFrames(text, nonce)).toThrow();
  });
  it('never accepts another child object as ownership evidence', async () => {
    const supervisor = createWindowsMigrationSupervisor();
    await expect(supervisor.release({ pid: 42 } as ChildProcess, 100)).rejects.toThrow(/unowned/);
  });
  it('cannot spawn before executable/platform admission', () => {
    expect(() => createWindowsMigrationSupervisor().spawn([])).toThrow(/not admitted/);
  });
});

// UNEXECUTED draft native controls. A fresh external execution grant must supply
// the opt-in; passing these is not DB/backend/lane-release evidence.
interface NativeGrant {
  readonly version: 1;
  readonly syntheticOnly: true;
  readonly allowOwnedJobTermination: true;
  readonly grant: string;
  readonly evidenceRoot: string;
  readonly nativePaths: WindowsSupervisorBinding;
}
function readNativeGrant(): NativeGrant | undefined {
  const path = process.env['PRACTICEHUB_NATIVE_SUPERVISOR_GRANT_PATH'];
  const pin = process.env['PRACTICEHUB_NATIVE_SUPERVISOR_GRANT_SHA256'];
  if (path === undefined && pin === undefined) return undefined;
  if (!path || !isAbsolute(path) || !pin || !/^[a-f0-9]{64}$/.test(pin))
    throw new Error('Pinned native grant required');
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== pin)
    throw new Error('Native grant hash mismatch');
  const value = JSON.parse(bytes.toString('utf8')) as NativeGrant;
  if (
    value.version !== 1 ||
    value.syntheticOnly !== true ||
    value.allowOwnedJobTermination !== true ||
    typeof value.grant !== 'string' ||
    !value.grant.trim() ||
    typeof value.evidenceRoot !== 'string' ||
    !isAbsolute(value.evidenceRoot) ||
    !value.nativePaths ||
    resolve(value.nativePaths.executablePath) !== resolve(process.execPath) ||
    value.nativePaths.powershellVersion !== '7.6.5' ||
    Object.keys(value).sort().join(',') !==
      'allowOwnedJobTermination,evidenceRoot,grant,nativePaths,syntheticOnly,version' ||
    Object.keys(value.nativePaths).sort().join(',') !==
      'executablePath,executableSha256,powershellPath,powershellSha256,powershellVersion'
  )
    throw new Error('Unsafe native fixture grant');
  for (const [executable, hash] of [
    [value.nativePaths.executablePath, value.nativePaths.executableSha256],
    [value.nativePaths.powershellPath, value.nativePaths.powershellSha256],
  ])
    if (
      !executable ||
      !isAbsolute(executable) ||
      !hash ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      createHash('sha256').update(readFileSync(executable)).digest('hex') !== hash
    )
      throw new Error('Native fixture executable pin mismatch');
  return value;
}
const nativeGrant = readNativeGrant();
const nativeGranted = process.platform === 'win32' && nativeGrant !== undefined;
describe.skipIf(!nativeGranted)('real Windows process-tree ownership', () => {
  function watch(child: ChildProcess) {
    let stdout = '';
    const ready = new Promise<void>((resolve, reject) => {
      const output = child.stdout;
      if (output === undefined || output === null)
        throw new Error('Native fixture child must provide stdout');
      output.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('READY\n')) resolve();
      });
      child.once('error', reject);
      child.once('close', () => {
        if (!stdout.includes('READY\n')) reject(new Error('Native fixture exited before ready'));
      });
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    return { ready, closed, stdout: () => stdout };
  }
  async function timeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('native fixture deadline')), 30000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  it.each(['normal-parent-exit', 'forced-running-tree', 'late-grandchild'] as const)(
    'proves closure for %s and stops grandchild effects',
    async (scenario) => {
      if (nativeGrant === undefined || nativeGrant === null)
        throw new Error('Native fixture grant required');
      const root = mkdtempSync(join(nativeGrant.evidenceRoot, 'ph-native-supervisor-'));
      const heartbeat = join(root, 'heartbeat.txt');
      const supervisor = createWindowsMigrationSupervisor({
        ...nativeGrant.nativePaths,
        onObservation: (event) =>
          appendFileSync(join(root, 'native-observations.ndjson'), JSON.stringify(event) + '\n'),
      });
      let child: ChildProcess | undefined;
      try {
        await supervisor.admit();
        const grandchild = `const fs=require('node:fs');const p=${JSON.stringify(heartbeat)};fs.appendFileSync(p,'start\\n');setInterval(()=>fs.appendFileSync(p,'tick\\n'),20);`;
        const source = `
          const {spawn}=require('node:child_process');
          if(process.env.PH_JOB_PAYLOAD||process.env.PH_JOB_SOURCE) throw Error('control credentials leaked');
          const run=()=>{
            spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',detached:true});
            setTimeout(()=>{process.stdout.write('READY\\n',()=>{${scenario === 'normal-parent-exit' ? 'process.exit(0);' : ''}});},200);
          };
          ${scenario === 'late-grandchild' ? 'setTimeout(run,200);' : 'run();'}
          setInterval(()=>{},1000);
        `;
        child = supervisor.spawn(['-e', source]);
        const observed = watch(child);
        await timeout(observed.ready);
        if (scenario === 'normal-parent-exit') await timeout(observed.closed);
        await supervisor.release(child, 15000);
        const after = readFileSync(heartbeat, 'utf8');
        expect(after).toContain('start');
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(readFileSync(heartbeat, 'utf8')).toBe(after);
        expect(observed.stdout()).toContain('READY');
      } finally {
        if (child) await supervisor.release(child, 15000);
        // Preserve native observations and grandchild heartbeat bytes for root review.
      }
    },
    60000,
  );
});

describe('native environment and fail-closed factory', () => {
  it('does not inherit Compose, Docker, compiler, module or proxy overrides', () => {
    expect(
      nativeEnvironment({
        SystemRoot: 'C:\\Windows',
        COMPOSE_FILE: 'foreign',
        DOCKER_HOST: 'tcp://foreign',
        PATH: 'foreign',
        PSModulePath: 'foreign',
        DOTNET_ROOT: 'foreign',
        HTTP_PROXY: 'foreign',
      }),
    ).toEqual({ SystemRoot: 'C:\\Windows', COMPOSE_DISABLE_ENV_FILE: '1' });
  });
  it('default factory construction is harmless without platform or executable admission', () => {
    expect(createWindowsMigrationSupervisor()).toHaveProperty('admit');
  });
});

// Real launcher cases. These remain skipped without the exact native grant.
// Wrapper/pre-Add-Type descendant inventory is an EXTERNAL observer obligation;
// these cases cannot certify that closure by reading their own wrapper receipt.
describe.skipIf(!nativeGranted)('real launcher cancellation and protocol failure paths', () => {
  it.each([
    'cancel-before-ready',
    'cancel-natural-close',
    'child-forged-frame',
    'child-failure',
  ] as const)(
    'retains honest terminal/UNKNOWN evidence for %s',
    async (scenario) => {
      if (nativeGrant === undefined || nativeGrant === null)
        throw new Error('Native fixture grant required');
      const root = mkdtempSync(join(nativeGrant.evidenceRoot, 'ph-native-edge-'));
      const eventPath = join(root, 'events.ndjson');
      const supervisor = createWindowsMigrationSupervisor({
        ...nativeGrant.nativePaths,
        onObservation: (event) => appendFileSync(eventPath, JSON.stringify(event) + '\n'),
      });
      await supervisor.admit();
      const source =
        scenario === 'child-forged-frame'
          ? "process.stderr.write('PHJOB:wrong-nonce:released:42:1:0:0\\n');process.exit(0)"
          : scenario === 'child-failure'
            ? 'process.exit(23)'
            : scenario === 'cancel-natural-close'
              ? 'setTimeout(()=>process.exit(0),10)'
              : 'setInterval(()=>{},1000)';
      const child = supervisor.spawn(['-e', source]);
      appendFileSync(
        eventPath,
        JSON.stringify({ kind: 'wrapper-start-observation-only', pid: child.pid, scenario }) + '\n',
      );
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const errors: unknown[] = [];
      // Track presence separately: thrown undefined/null/false/0 must still reject.
      let failed = false;
      let failure: unknown;
      try {
        if (scenario === 'child-forged-frame' || scenario === 'child-failure') await closed;
        try {
          await supervisor.release(child, 15000);
        } catch (error) {
          errors.push(error);
        }
        if (scenario === 'child-forged-frame') expect(errors).toHaveLength(1);
        if (scenario === 'child-failure') {
          expect(errors).toHaveLength(0);
          expect(child.exitCode).toBe(23);
        }
        // Early/racing cancellation may be UNKNOWN. Persist it, never turn it
        // into a native release success; independent observer must clear the tree.
        appendFileSync(
          eventPath,
          JSON.stringify({
            kind: 'edge-result',
            scenario,
            unknown: errors.map(String),
            exitCode: child.exitCode,
          }) + '\n',
        );
        if (errors.length && scenario !== 'child-forged-frame')
          throw new AggregateError(errors, 'Native edge closure UNKNOWN');
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        try {
          // Owned handle wrapper termination is cleanup only, never proof.
          if (child.exitCode === null && child.signalCode === null) {
            try {
              await supervisor.release(child, 15000);
            } catch (error) {
              failed = true;
              failure = error;
              appendFileSync(
                eventPath,
                JSON.stringify({ kind: 'cleanup-UNKNOWN', error: String(error) }) + '\n',
              );
            }
          }
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
      if (failed) throw failure;
    },
    60000,
  );
});
