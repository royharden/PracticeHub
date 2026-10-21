export interface AttributionRow {
  readonly campaignId: string;
  readonly sends: number;
  readonly conversions: number;
}

export interface AttributionTotals {
  readonly sends: number;
  readonly conversions: number;
  readonly conversionRateBps: number;
}

export function attribute(rows: readonly AttributionRow[]): AttributionTotals {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.sends) || !Number.isSafeInteger(row.conversions)) {
      throw new Error('attribution counts must be whole numbers');
    }
    if (row.sends < 0 || row.conversions < 0 || row.conversions > row.sends) {
      throw new Error('attribution rows must be non-negative with conversions not above sends');
    }
    if (seen.has(row.campaignId)) {
      throw new Error(`campaign ${row.campaignId} appears more than once`);
    }
    seen.add(row.campaignId);
  }
  const sends = rows.reduce((sum, row) => sum + row.sends, 0);
  const conversions = rows.reduce((sum, row) => sum + row.conversions, 0);
  if (sends <= 0) {
    throw new Error('attribution rows must be non-negative and include at least one send');
  }
  return {
    sends,
    conversions,
    conversionRateBps: Math.round((conversions * 10000) / sends),
  };
}
