import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One source file, keyed by its path relative to modules/rcm/src with forward slashes. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every non-test TypeScript file under modules/rcm/src, recursively (any seat's folder).
 * Files named *test-support* are included too (H-17, NR-126 m8): a production file cannot hide
 * from the scan by its name. Only `*.test.ts` files are left out.
 */
export function rcmSourceFiles(): readonly SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push({
          path: relative(SRC, full).split(sep).join('/'),
          text: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(SRC);
  return out;
}

const MINT_HOME = 'coding/review-mint.ts';
/** This scanner names the mint in its own rules; it is the only exempt file besides the mint. */
const SCAN_HOME = 'coding/no-autonomy-scan.test-support.ts';
const WORKLIST = 'coding/worklist.ts';
const MINT_IDS = /\b(mintReviewedCode|revokeReviewedCode)\b/;
const ALIASED = /\b(mintReviewedCode|revokeReviewedCode)\s+as\s+\w+/;
const NAMESPACE_IMPORT = /import\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*review-mint(\.js)?['"]/;
const DYNAMIC_IMPORT = /import\(\s*['"][^'"]*review-mint(\.js)?['"]\s*\)/;
const STAR_REEXPORT = /export\s*\*\s*(as\s+\w+\s+)?from\s*['"][^'"]*review-mint(\.js)?['"]/;
/** `.call`, `.apply` or `.bind` on the mint (NR-126 m7). */
const INDIRECTION = /\b(mintReviewedCode|revokeReviewedCode)\s*\.\s*(call|apply|bind)\b/;
/** A static or dynamic import of any module whose name contains test-support. */
const TEST_SUPPORT_IMPORT = /(from\s*|import\(\s*)['"][^'"]*test-support[^'"]*['"]/;
const NAMED_IMPORT = /import\s*(type\s*)?\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g;

function methodBody(text: string, signature: string): readonly [number, number] | null {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const next = [text.indexOf('\n  public ', start + 1), text.indexOf('\n  private ', start + 1)]
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  return [start, next ?? text.length];
}

/**
 * Occurrences of an identifier (any use: call, value reference, re-export, indirection) outside
 * the file's named-import declarations and outside the one method allowed to use it.
 */
function usesOutside(
  text: string,
  identifier: RegExp,
  body: readonly [number, number] | null,
): number {
  const imports = [...text.matchAll(NAMED_IMPORT)].map(
    (m) => [m.index, m.index + m[0].length] as const,
  );
  const inImport = (i: number): boolean => imports.some(([from, to]) => i >= from && i < to);
  const inBody = (i: number): boolean => body !== null && i >= body[0] && i < body[1];
  return [...text.matchAll(identifier)].filter((m) => !inImport(m.index) && !inBody(m.index))
    .length;
}

function callsOutside(
  text: string,
  pattern: RegExp,
  body: readonly [number, number] | null,
): number {
  const calls = [...text.matchAll(pattern)].map((m) => m.index);
  if (body === null) return calls.length;
  return calls.filter((i) => i < body[0] || i >= body[1]).length;
}

const isTestSupport = (path: string): boolean => path.includes('test-support');

/**
 * The structural no-autonomy rule for WP-087, as one check. Returns a violation per breach:
 * - only review-mint.ts and worklist.ts may name mintReviewedCode or revokeReviewedCode, in any
 *   form (call, import, alias, re-export), whatever the file is named;
 * - nobody may namespace-import, dynamically import or star-re-export review-mint, or call the
 *   mint through `.call`, `.apply` or `.bind`;
 * - worklist.ts may not alias them, and may use mintReviewedCode only in its import and inside
 *   `review`, and revokeReviewedCode only in its import and inside `quarantineIfKilled`. Any other
 *   use, including a value re-export such as `export const issueCode = mintReviewedCode`, is a
 *   violation;
 * - `.attachReviewedCode(` is called only inside `CodingWorklist.attach`;
 * - no production file imports a test-support module.
 */
export function scanNoAutonomy(files: readonly SourceFile[]): readonly string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (file.path === MINT_HOME || file.path === SCAN_HOME) continue;
    if (NAMESPACE_IMPORT.test(file.text))
      violations.push(`${file.path}: namespace import of review-mint`);
    if (DYNAMIC_IMPORT.test(file.text))
      violations.push(`${file.path}: dynamic import of review-mint`);
    if (STAR_REEXPORT.test(file.text))
      violations.push(`${file.path}: star re-export of review-mint`);
    if (INDIRECTION.test(file.text)) violations.push(`${file.path}: indirect call of the mint`);
    if (!isTestSupport(file.path) && TEST_SUPPORT_IMPORT.test(file.text)) {
      violations.push(`${file.path}: production file imports a test-support module`);
    }
    if (file.path !== WORKLIST && MINT_IDS.test(file.text)) {
      violations.push(`${file.path}: references the mint outside the worklist`);
    }
    const attachCalls = [...file.text.matchAll(/\.attachReviewedCode\(/g)].length;
    if (file.path !== WORKLIST && attachCalls > 0) {
      violations.push(`${file.path}: calls a claim port outside CodingWorklist.attach`);
    }
    if (file.path === WORKLIST) {
      if (ALIASED.test(file.text)) violations.push(`${file.path}: aliases the mint`);
      const review = methodBody(file.text, 'public review(');
      if (review === null) violations.push(`${file.path}: review() not found`);
      if (usesOutside(file.text, /\bmintReviewedCode\b/g, review) > 0) {
        violations.push(`${file.path}: mints outside review()`);
      }
      if (
        usesOutside(
          file.text,
          /\brevokeReviewedCode\b/g,
          methodBody(file.text, 'private quarantineIfKilled('),
        ) > 0
      ) {
        violations.push(`${file.path}: revokes outside quarantineIfKilled()`);
      }
      if (
        callsOutside(
          file.text,
          /\.attachReviewedCode\(/g,
          methodBody(file.text, 'public attach('),
        ) > 0
      ) {
        violations.push(`${file.path}: calls a claim port outside attach()`);
      }
    }
  }
  return violations;
}
