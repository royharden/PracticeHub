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
  const sends = rows.reduce((sum, row) => sum + row.sends, 0);
  const conversions = rows.reduce((sum, row) => sum + row.conversions, 0);
  if (sends <= 0 || conversions < 0 || rows.some((row) => row.sends < 0 || row.conversions < 0)) {
    throw new Error('attribution rows must be non-negative and include at least one send');
  }
  return {
    sends,
    conversions,
    conversionRateBps: Math.round((conversions * 10000) / sends),
  };
}
