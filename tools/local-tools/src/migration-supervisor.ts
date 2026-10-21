import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
import { localDockerSelection, type LocalDockerBinding } from './compose-config.js';

export interface MigrationProcessSupervisor {
  admit(): Promise<void>;
  spawn(
    args: readonly string[],
    context?: { readonly applicationTag?: string; readonly docker?: LocalDockerBinding },
  ): ChildProcess;
  release(child: ChildProcess, milliseconds: number): Promise<void>;
}
export interface NativeJobObservation {
  readonly kind: 'native-job-release';
  readonly wrapperPid: number | undefined;
  readonly pid: number;
  readonly created: string;
  readonly exitCode: number;
  readonly active: 0;
  readonly job: string;
  readonly applicationTag?: string;
}
export interface WindowsSupervisorBinding {
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly powershellPath: string;
  readonly powershellSha256: string;
  readonly powershellVersion: '7.6.5';
}
export interface WindowsSupervisorOptions extends Partial<WindowsSupervisorBinding> {
  readonly onObservation?: (event: NativeJobObservation) => void;
}

// Upstream compiler path candidate (not loaded-dependency/descendant proof): PowerShell/PowerShell v7.6.5 AddType.cs 980-997,
// 1075-1085 invokes Roslyn and loads a MemoryStream in-process. This source
// reasoning does not replace real wrapper-descendant inventory controls.
// https://github.com/PowerShell/PowerShell/blob/v7.6.5/src/Microsoft.PowerShell.Commands.Utility/commands/utility/AddType.cs
// Fixed public source; no command text is interpolated. Arguments travel as JSON.
// The job handle is never inherited. Descendants cannot break away from the job.
const supervisorSource = String.raw`
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class PHMigrationJob {
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint faults,total,active,terminated; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct START { public int size; public string reserved,desktop,title; public uint x,y,width,height,xchars,ychars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct TIME { public uint low,high; public ulong Value { get { return ((ulong)high<<32)|low; } } }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXT info,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNT info,uint length,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out TIME created,out TIME exited,out TIME kernel,out TIME user);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref START startup,out PROCESS process);
 static void Check(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static string Quote(string value) {
  StringBuilder b=new StringBuilder("\""); int slash=0;
  foreach(char c in value) {
   if(c=='\\') { slash++; continue; }
   if(c=='"') { b.Append('\\',slash*2+1); b.Append(c); slash=0; continue; }
   b.Append('\\',slash); slash=0; b.Append(c);
  }
  b.Append('\\',slash*2); return b.Append('"').ToString();
 }
 static void Frame(string nonce,string phase,uint pid,ulong created,uint active,uint exit) {
  Console.Error.WriteLine("PHJOB:"+nonce+":"+phase+":"+pid+":"+created+":"+active+":"+exit);
  Console.Error.Flush();
 }
 public static int Run(string executable,string[] arguments,string nonce,string pipeName) {
  IntPtr job=IntPtr.Zero; PROCESS process=new PROCESS(); bool assigned=false; NamedPipeServerStream pipe=null; object gate=new object(); bool jobOpen=false;
  try {
   // Restrict control to this user's SID; random name plus nonce binds ownership.
   pipe=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly,4096,4096);
   job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero); jobOpen=true;
   EXT limits=new EXT(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no BREAKAWAY flags
   Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))));
   START startup=new START(); startup.size=Marshal.SizeOf(typeof(START)); startup.flags=0x100;
   startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
   Check(SetHandleInformation(startup.input,1,1)); Check(SetHandleInformation(startup.output,1,1)); Check(SetHandleInformation(startup.error,1,1));
   StringBuilder command=new StringBuilder(Quote(executable));
   foreach(string arg in arguments) command.Append(" ").Append(Quote(arg));
   // Do not leak control credentials to the process being supervised.
   Environment.SetEnvironmentVariable("PH_JOB_SOURCE",null);
   Environment.SetEnvironmentVariable("PH_JOB_PAYLOAD",null);
   Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref startup,out process));
   // All failure paths before assignment terminate via the held process HANDLE.
   Check(AssignProcessToJobObject(job,process.process)); assigned=true;
   TIME created,exited,kernel,user; Check(GetProcessTimes(process.process,out created,out exited,out kernel,out user));
   Frame(nonce,"owned",process.pid,created.Value,1,259);
   NamedPipeServerStream control=pipe; IntPtr ownedJob=job;
   Task cancellation=Task.Run(delegate {
    try {
     control.WaitForConnection();
     using(StreamReader reader=new StreamReader(control,Encoding.UTF8,false,4096,true)) {
      // Fixed-size bounded read, not an unbounded ReadLine from the control pipe.
      char[] token=new char[nonce.Length+1]; int length=0;
      while(length<token.Length) { int got=reader.Read(token,length,token.Length-length); if(got==0) break; length+=got; }
      if(length==token.Length && new string(token)==nonce+"\n") { lock(gate) { if(jobOpen) Check(TerminateJobObject(ownedJob,137)); } }
     }
    } catch(ObjectDisposedException) {} catch(IOException) {}
   });
   if(ResumeThread(process.thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
   Check(WaitForSingleObject(process.process,0xffffffff)==0);
   uint code; Check(GetExitCodeProcess(process.process,out code));
   // A parent can exit while a grandchild lives. Reap the WHOLE owned job.
   Check(TerminateJobObject(job,137));
   DateTime deadline=DateTime.UtcNow.AddSeconds(10); ACCOUNT account;
   do {
    Check(QueryInformationJobObject(job,1,out account,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));
    if(account.active==0) break;
    if(DateTime.UtcNow>=deadline) throw new Exception("owned job did not empty");
    Thread.Sleep(10);
   } while(true);
   Frame(nonce,"released",process.pid,created.Value,account.active,code);
   return unchecked((int)code);
  } catch(Exception e) {
   Console.Error.WriteLine("PHJOB:"+nonce+":unknown:"+e.GetType().Name); return 125;
  } finally {
   if(pipe!=null) pipe.Dispose();
   if(process.process!=IntPtr.Zero && !assigned) { TerminateProcess(process.process,125); WaitForSingleObject(process.process,10000); }
   lock(gate) { jobOpen=false; if(job!=IntPtr.Zero) CloseHandle(job); }
   if(process.thread!=IntPtr.Zero) CloseHandle(process.thread);
   if(process.process!=IntPtr.Zero) CloseHandle(process.process);
  }
 }
}
`;
const launcher = String.raw`
$ErrorActionPreference='Stop'
try {
  if($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.ToString() -ne '7.6.5') { throw 'Pinned PowerShell 7.6.5 Core required' }
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PH_JOB_SOURCE)))
  $p=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PH_JOB_PAYLOAD)) | ConvertFrom-Json)
  exit [PHMigrationJob]::Run([string]$p.executable,[string[]]$p.arguments,[string]$p.nonce,[string]$p.pipe)
} catch { [Console]::Error.WriteLine('PHJOB:launcher-failed'); exit 125 }
`;

export interface JobReceipt {
  readonly pid: number;
  readonly created: string;
  readonly exitCode: number;
}
/** Strict protocol parser exported for negative controls; it conveys no ownership. */
export function parseJobFrames(text: string, nonce: string): JobReceipt {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith('PHJOB:'));
  if (lines.length !== 2) throw new Error('Missing/extra native job receipt');
  const parsed = lines.map((line) => line.split(':'));
  const owned = parsed[0];
  const released = parsed[1];
  if (owned === null || owned === undefined || released === null || released === undefined)
    throw new Error('Missing/extra native job receipt');
  if (owned.length !== 7 || released.length !== 7)
    throw new Error('Native job identity/release mismatch');
  const pidText = owned[3];
  const created = owned[4];
  const exitText = released[6];
  if (
    owned[1] !== nonce ||
    released[1] !== nonce ||
    owned[2] !== 'owned' ||
    released[2] !== 'released' ||
    owned[3] !== released[3] ||
    owned[4] !== released[4] ||
    pidText === null ||
    pidText === undefined ||
    !/^[1-9][0-9]*$/.test(pidText) ||
    created === null ||
    created === undefined ||
    !/^[1-9][0-9]*$/.test(created) ||
    owned[5] !== '1' ||
    owned[6] !== '259' ||
    released[5] !== '0' ||
    exitText === null ||
    exitText === undefined ||
    !/^\d+$/.test(exitText)
  )
    throw new Error('Native job identity/release mismatch');
  const pid = Number(pidText);
  const exitCode = Number(exitText);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(exitCode) || exitCode > 0xffffffff)
    throw new Error('Invalid native job numeric identity');
  return { pid, created, exitCode };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native job supervision timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Called only after ownership lookup. A failed close is as consequential as a failed pipe write. */
export async function closeOwnedJob(
  writeControl: () => Promise<void>,
  closed: Promise<number | null>,
  terminateHeldChild: () => void,
  milliseconds: number,
): Promise<number | null> {
  try {
    await within(writeControl(), milliseconds);
    return await within(closed, milliseconds);
  } catch (cause) {
    const failures: unknown[] = [cause];
    try {
      terminateHeldChild();
    } catch (error) {
      failures.push(error);
    }
    try {
      await within(closed, milliseconds);
    } catch (error) {
      failures.push(error);
    }
    throw new AggregateError(failures, 'Native cancellation/release UNKNOWN', { cause });
  }
}

/** No ambient Compose/Docker/PowerShell/.NET search overrides enter owned commands.
 * This does not prove distribution assembly closure; that requires external observation.
 */
export function nativeEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { COMPOSE_DISABLE_ENV_FILE: '1' };
  for (const key of [
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
  ])
    if (input[key] !== undefined) result[key] = input[key];
  return result;
}

export function createWindowsMigrationSupervisor(
  options: WindowsSupervisorOptions = {},
): MigrationProcessSupervisor {
  const powershell = options.powershellPath ?? '';
  const executable = options.executablePath ?? '';
  const records = new WeakMap<
    ChildProcess,
    {
      nonce: string;
      pipe: string;
      applicationTag?: string;
      closed: Promise<number | null>;
      frames: () => string;
      failure: () => Error | undefined;
    }
  >();
  let admitted = false;
  function checkPins(): void {
    for (const [path, hash] of [
      [powershell, options.powershellSha256],
      [executable, options.executableSha256],
    ]) {
      if (
        !path ||
        !isAbsolute(path) ||
        !existsSync(path) ||
        !lstatSync(path).isFile() ||
        lstatSync(path).isSymbolicLink() ||
        realpathSync(path).toLowerCase() !== path.toLowerCase() ||
        !hash ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        createHash('sha256').update(readFileSync(path)).digest('hex') !== hash
      )
        throw new Error('Pinned absolute native supervisor executable/hash required');
    }
  }
  return {
    async admit() {
      if (process.platform !== 'win32')
        throw new Error('Native migration supervisor currently requires Windows');
      if (options.powershellVersion !== '7.6.5')
        throw new Error('Reviewed PowerShell 7.6.5 Core binding required');
      checkPins();
      admitted = true;
    },
    spawn(args, context) {
      if (!admitted) throw new Error('Native migration supervisor was not admitted');
      checkPins();
      const docker = context?.docker ? localDockerSelection(context.docker) : undefined;
      if (
        docker &&
        args.some((arg) => /^(?:--(?:host|context|config)(?:=|$)|-H|-c(?:=|$))/.test(arg))
      )
        throw new Error('Docker selector override refused');
      const nonce = randomBytes(32).toString('hex');
      const pipe = `practicehub-migration-${randomBytes(32).toString('hex')}`;
      const child = spawn(
        powershell,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(launcher, 'utf16le').toString('base64'),
        ],
        {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...nativeEnvironment(),
            ...docker?.env,
            PH_JOB_SOURCE: Buffer.from(supervisorSource).toString('base64'),
            PH_JOB_PAYLOAD: Buffer.from(
              JSON.stringify({
                executable,
                arguments: [...(docker?.args ?? []), ...args],
                nonce,
                pipe,
              }),
            ).toString('base64'),
          },
        },
      );
      let frames = '';
      let failure: Error | undefined;
      const stderr = child.stderr;
      if (stderr === null || stderr === undefined)
        throw new Error('Native supervisor stderr pipe required');
      stderr.on('data', (chunk: Buffer) => {
        if (frames.length + chunk.length > 1024 * 1024)
          failure = new Error('Native supervisor stderr bound exceeded');
        else frames += chunk.toString();
      });
      const closed = new Promise<number | null>((resolve) => {
        child.once('error', (error) => {
          failure = error;
        });
        child.once('close', (code) => resolve(code));
      });
      records.set(child, {
        nonce,
        pipe,
        ...(context?.applicationTag ? { applicationTag: context.applicationTag } : {}),
        closed,
        frames: () => frames,
        failure: () => failure,
      });
      return child;
    },
    async release(child, milliseconds) {
      const record = records.get(child);
      if (!record) throw new Error('Cannot release an unowned native process');
      if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
        throw new Error('Bounded native release deadline required');
      const code = await closeOwnedJob(
        async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          let control: ReturnType<typeof connect> | undefined;
          try {
            await within(
              new Promise<void>((resolve, reject) => {
                const socket = connect(`\\\\.\\pipe\\${record.pipe}`);
                control = socket;
                socket.once('error', reject);
                socket.once('connect', () => socket.end(record.nonce + '\n', resolve));
                socket.setTimeout(milliseconds, () => {
                  socket.destroy();
                  reject(new Error('Native control pipe timeout'));
                });
              }),
              milliseconds,
            );
          } finally {
            control?.destroy();
          }
        },
        record.closed,
        () => {
          // This exact ChildProcess was looked up above; never reacquire by PID.
          if (child.exitCode === null && child.signalCode === null && !child.kill())
            throw new Error('Held wrapper termination refused');
        },
        milliseconds,
      );
      if (record.failure()) throw record.failure();
      const receipt = parseJobFrames(record.frames(), record.nonce);
      if (code !== receipt.exitCode || child.signalCode !== null)
        throw new Error('Native wrapper/owned process exit mismatch');
      options.onObservation?.(
        Object.freeze({
          kind: 'native-job-release',
          wrapperPid: child.pid,
          ...receipt,
          active: 0,
          job: record.nonce,
          ...(record.applicationTag ? { applicationTag: record.applicationTag } : {}),
        }),
      );
    },
  };
}
