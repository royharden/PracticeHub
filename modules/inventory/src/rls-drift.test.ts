import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { extractRlsMigrationSection, renderRlsMigrationSection } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  inventoryHistoricalRlsSpecs,
  inventoryRecallRlsSpecs,
  inventoryRlsSpecs,
} from './rls-specs.js';

const sql = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
describe('inventory immutable historical and forward RLS epochs', () => {
  it.each([
    [
      '0066-wp075-inventory.sql',
      '7bf23488a15f877bc9489a0e1733747cb28921d8c355fa0b3c09879d99c24ad1',
    ],
    [
      '0066-wp075-inventory.rollback.sql',
      'ffe6017231099b529c468f7939137ee4a40b0eecf2901773273c57f23d75de3d',
    ],
  ])('pins raw historical bytes: %s', (name, hash) => {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL(`../migrations/${name}`, import.meta.url)))
        .digest('hex'),
    ).toBe(hash);
  });
  it('keeps six-table history and seven-table forward epoch separate', () => {
    expect(inventoryHistoricalRlsSpecs).toHaveLength(6);
    expect(inventoryRlsSpecs).toHaveLength(7);
    expect(extractRlsMigrationSection(sql('0066-wp075-inventory.sql'))).toBe(
      renderRlsMigrationSection('inventory', inventoryHistoricalRlsSpecs),
    );
    expect(extractRlsMigrationSection(sql('0074-inventory-recall-events.sql'))).toBe(
      renderRlsMigrationSection('inventory', inventoryRecallRlsSpecs, inventoryRlsSpecs),
    );
    expect(extractRlsMigrationSection(sql('0074-inventory-recall-events.rollback.sql'))).toBe(
      renderRlsMigrationSection('inventory', [], inventoryHistoricalRlsSpecs),
    );
  });
  it('requires missing-table checks, bounded rollback and caller-owned atomicity', () => {
    for (const name of [
      '0074-inventory-recall-events.sql',
      '0074-inventory-recall-events.rollback.sql',
    ]) {
      const text = sql(name);
      expect(text).toContain('inventory-0074 prerequisite missing ordinary tables: %');
      expect(text).toContain("AND c.relkind='r' AND c.relname=expected");
      expect(text).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
    }
    const undo = sql('0074-inventory-recall-events.rollback.sql');
    expect(undo.match(/^DROP TABLE .*;/gm)).toEqual([
      'DROP TABLE IF EXISTS inventory.lot_recall_event;',
    ]);
    expect(undo).not.toMatch(/\bCASCADE\s*;|^\s*(GRANT|REVOKE|ALTER ROLE|DROP SCHEMA)/m);
  });
});

it('copies the complete accepted event table shape unchanged', () => {
  const shape = sql('0074-inventory-recall-events.sql').match(
    /CREATE TABLE IF NOT EXISTS inventory\.lot_recall_event \([\s\S]*?\n\);/,
  )?.[0];
  expect(shape).toBeDefined();
  expect(
    createHash('sha256')
      .update(shape ?? '')
      .digest('hex'),
  ).toBe('7ec266f3ccc7900929296b6ea1e6b42abbcb2ba8e9eace8f2f44977cd53b61b5');
});
