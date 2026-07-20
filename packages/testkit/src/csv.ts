export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

export function records(
  rows: readonly string[][],
): ReadonlyArray<Readonly<Record<string, string>>> {
  const header = rows[0];
  if (!header) {
    return [];
  }
  return rows
    .slice(1)
    .map((row) =>
      Object.fromEntries(
        header.map((column, index) => [column.replace(/^\uFEFF/, ''), row[index] ?? '']),
      ),
    );
}

export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function serializeCsv(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [header, ...rows].map((row) => row.map(csvField).join(','));
  return `${lines.join('\n')}\n`;
}
