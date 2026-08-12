/**
 * Control-byte scanner (ruling ADR-ADJ-015 builder task R-2; NR-048 class).
 *
 * A raw control byte inside a tracked source file is invisible in every review
 * surface — editors, diffs, and terminal output all render it as nothing. That
 * is how a deliberate composite-key delimiter came to be characterised as a
 * "stray, functionally inert" byte and nearly deleted, which would have
 * silently changed key semantics (a+bc colliding with ab+c).
 *
 * The rule: a tracked file may contain TAB (0x09), LF (0x0A) and CR (0x0D) and
 * no other control byte. DEL (0x7F) counts as a control byte. Anything else
 * belongs in source as an escape (`\\u0000`), which reviews can see.
 *
 * The scanner reads file BYTES rather than decoded text, because a decoder
 * normalises away exactly what is being looked for. It contains no raw control
 * byte itself, so it is subject to its own rule with no exemption, and it has
 * no allowlist — an exception here would reintroduce the blind spot it exists
 * to close.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { failIfAny, repoRoot } from './common.js';

const tab = 0x09;
const lineFeed = 0x0a;
const carriageReturn = 0x0d;
const firstPrintable = 0x20;
const del = 0x7f;

function isRawControlByte(byte: number): boolean {
  if (byte === tab || byte === lineFeed || byte === carriageReturn) {
    return false;
  }
  return byte < firstPrintable || byte === del;
}

function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `control-bytes: 'git ls-files' failed (status ${String(result.status)}): ${result.stderr}`,
    );
  }
  // -z separates paths with NUL, written here as an escape so this scanner
  // holds no raw control byte of its own.
  return result.stdout.split('\u0000').filter((entry) => entry.length > 0);
}

/** 1-indexed line and column of a byte offset, counting LF as the line break. */
function locate(bytes: Buffer, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (bytes[index] === lineFeed) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

const errors: string[] = [];
const files = trackedFiles();
let hits = 0;

for (const file of files) {
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(repoRoot, file));
  } catch {
    // A tracked path that cannot be read here (submodule gitlink, sparse
    // checkout) carries no bytes to scan; git would have failed the checkout.
    continue;
  }
  let firstHit: number | null = null;
  let fileHits = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== undefined && isRawControlByte(byte)) {
      fileHits += 1;
      if (firstHit === null) {
        firstHit = index;
      }
    }
  }
  if (firstHit !== null) {
    hits += fileHits;
    const byte = bytes[firstHit] ?? 0;
    const where = locate(bytes, firstHit);
    const code = `0x${byte.toString(16).padStart(2, '0')}`;
    errors.push(
      `${file}:${where.line}:${where.column} (byte offset ${firstHit}) holds raw control byte ` +
        `${code}${fileHits > 1 ? ` (${fileHits} in this file)` : ''} — write it as an escape ` +
        `such as \\u${byte.toString(16).padStart(4, '0')}; REPLACE, never delete: a delimiter ` +
        'byte carries key semantics',
    );
  }
}

console.log(`control_bytes_swept=${files.length} raw_control_bytes=${hits}`);
failIfAny('control_bytes', errors);
