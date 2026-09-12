import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TenantId } from '@practicehub/contracts';

import { sha256 } from './guards.js';
import type { ObjectStorePort, StoredBody } from './ports.js';

interface DiskObject {
  readonly tenantId: TenantId;
  readonly subjectRef: string;
  readonly bodyRef: string;
  readonly bodyHash: string;
  readonly originRef: string;
  readonly trust: 'untrusted-data';
  readonly body: string;
  readonly synthetic: true;
}

let tempSequence = 0;

function objectKey(
  tenantId: string,
  subjectRef: string,
  originRef: string,
  bodyHash: string,
): string {
  return sha256(`${tenantId}\u0000${subjectRef}\u0000${originRef}\u0000${bodyHash}`);
}

/**
 * Durable dev-only object binding. SQL receives opaque refs and hashes only;
 * synthetic bodies remain in this caller-selected local directory.
 */
export class FileObjectStore implements ObjectStorePort {
  public constructor(private readonly baseDirectory: string) {}

  public async get(ref: Parameters<ObjectStorePort['get']>[0]): Promise<StoredBody> {
    const key = objectKey(ref.tenantId, ref.subjectRef, ref.originRef, ref.bodyHash);
    const expectedRef = `object:ai:${key}`;
    if (ref.bodyRef !== expectedRef)
      throw new Error('object ref is not valid for the supplied scope');
    const parsed = JSON.parse(
      await readFile(join(this.baseDirectory, `${key}.json`), 'utf8'),
    ) as DiskObject;
    if (
      parsed.tenantId !== ref.tenantId ||
      parsed.subjectRef !== ref.subjectRef ||
      parsed.bodyRef !== ref.bodyRef ||
      parsed.bodyHash !== ref.bodyHash ||
      parsed.originRef !== ref.originRef ||
      parsed.synthetic !== true ||
      parsed.trust !== 'untrusted-data' ||
      sha256(parsed.body) !== ref.bodyHash
    ) {
      throw new Error('stored object metadata or hash does not match the scoped reference');
    }
    return parsed;
  }

  public async put(input: Parameters<ObjectStorePort['put']>[0]): Promise<StoredBody> {
    const bodyHash = sha256(input.body);
    const key = objectKey(input.tenantId, input.subjectRef, input.originRef, bodyHash);
    const stored: DiskObject = {
      ...input,
      bodyRef: `object:ai:${key}`,
      bodyHash,
      trust: 'untrusted-data',
    };
    await mkdir(this.baseDirectory, { recursive: true });
    const destination = join(this.baseDirectory, `${key}.json`);
    tempSequence += 1;
    const temporary = join(this.baseDirectory, `${key}.${process.pid}.${tempSequence}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', flag: 'wx' });
      try {
        await rename(temporary, destination);
      } catch (error) {
        try {
          return await this.get(stored);
        } catch {
          throw error;
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return stored;
  }
}
