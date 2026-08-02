import type { FarmProductionProfile, FarmSale, FarmSalesChannel } from './types';

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Sales channels in display order. */
export const FARM_SALES_CHANNELS = ['farmers_market', 'wholesale', 'direct', 'csa', 'other'] as const;
/** Unlinked current-year sales revenue above this total raises a fix action. */
export const UNLINKED_REVENUE_ACTION_THRESHOLD = 100;
/** Unlinked current-year sales revenue above this total escalates the action to a warning. */
export const UNLINKED_REVENUE_WARNING_THRESHOLD = 1_000;
/** Products with more than this much current-year revenue are screened for thin margins. */
export const MARGIN_ALERT_REVENUE_THRESHOLD = 500;
/** Gross margin below this percent triggers the margin alert. */
export const MARGIN_ALERT_PERCENT = 20;
/** Number of upcoming market days projected onto the timeline. */
export const MARKET_DAYS_AHEAD = 4;

const MS_PER_DAY = 86_400_000;

function recordYear(date: string): number {
  return Number(date.slice(0, 4));
}

function emptyChannels(): Record<FarmSalesChannel, number> {
  return { farmers_market: 0, wholesale: 0, direct: 0, csa: 0, other: 0 };
}

function sumRevenue(sales: FarmSale[]): number {
  return round2(sales.reduce((sum, sale) => sum + sale.revenue, 0));
}

export function calculateFarmProduction(profile: FarmProductionProfile, asOf = new Date()) {
  const { settings } = profile;
  const asOfDate = asOf.toISOString().slice(0, 10);
  const currentYear = asOf.getUTCFullYear();
  const priorYear = currentYear - 1;
  const productIds = new Set(profile.products.map(product => product.id));

  const buildYear = (year: number) => {
    const yearSales = profile.sales.filter(sale => recordYear(sale.date) === year);
    const yearCosts = profile.costs.filter(cost => cost.year === year);
    // Whole-farm pool: costs without a productId, plus costs pointing at a
    // product that no longer exists.
    const wholeFarmCost = yearCosts
      .filter(cost => cost.productId == null || !productIds.has(cost.productId))
      .reduce((sum, cost) => sum + cost.amount, 0);
    const base = profile.products.map(product => {
      const produced = profile.harvests
        .filter(harvest => harvest.productId === product.id && recordYear(harvest.date) === year)
        .reduce((sum, harvest) => sum + harvest.quantity, 0);
      const productSales = yearSales.filter(sale => sale.productId === product.id);
      const sold = productSales.reduce((sum, sale) => sum + sale.quantity, 0);
      const adjustment = profile.adjustments
        .filter(item => item.productId === product.id && recordYear(item.date) === year)
        .reduce((sum, item) => sum + item.quantityDelta, 0);
      // On-hand carries across years: everything dated in or before this year.
      const onHand = profile.harvests
        .filter(harvest => harvest.productId === product.id && recordYear(harvest.date) <= year)
        .reduce((sum, harvest) => sum + harvest.quantity, 0)
        + profile.adjustments
          .filter(item => item.productId === product.id && recordYear(item.date) <= year)
          .reduce((sum, item) => sum + item.quantityDelta, 0)
        - profile.sales
          .filter(sale => sale.productId === product.id && recordYear(sale.date) <= year)
          .reduce((sum, sale) => sum + sale.quantity, 0);
      const revenueByChannel = emptyChannels();
      for (const sale of productSales) {
        revenueByChannel[sale.channel] = round2(revenueByChannel[sale.channel] + sale.revenue);
      }
      const specificCost = yearCosts
        .filter(cost => cost.productId === product.id)
        .reduce((sum, cost) => sum + cost.amount, 0);
      return { product, produced, sold, adjustment, onHand, revenue: sumRevenue(productSales), revenueByChannel, specificCost };
    });
    const shareRevenue = base.reduce((sum, row) => sum + row.revenue, 0);
    const shareProduced = base.reduce((sum, row) => sum + row.produced, 0);
    const products = base.map(row => {
      // Whole-farm costs allocate by revenue share; with no revenue anywhere,
      // fall back to produced-quantity share; with neither, nothing allocates.
      const share = shareRevenue > 0
        ? row.revenue / shareRevenue
        : shareProduced > 0
          ? row.produced / shareProduced
          : 0;
      const allocatedCost = round2(row.specificCost + wholeFarmCost * share);
      const unitCost = row.produced > 0 ? round2(allocatedCost / row.produced) : 0;
      const grossMargin = round2(row.revenue - allocatedCost);
      return {
        productId: row.product.id,
        name: row.product.name,
        unit: row.product.unit,
        category: row.product.category,
        targetPrice: row.product.targetPrice ?? null,
        producedQty: round2(row.produced),
        soldQty: round2(row.sold),
        adjustmentQty: round2(row.adjustment),
        // Floor is intentionally NOT applied: negative on-hand is a
        // data-quality signal, not a valid stock level.
        onHandQty: round2(row.onHand),
        revenue: row.revenue,
        revenueByChannel: row.revenueByChannel,
        allocatedCost,
        unitCost,
        grossMargin,
        marginPercent: row.revenue > 0 ? round2(grossMargin / row.revenue * 100) : 0,
        cogsEstimate: round2(unitCost * row.sold),
        inventoryValue: Math.max(0, round2(row.onHand * unitCost)),
      };
    });
    const revenueByChannel = emptyChannels();
    for (const sale of yearSales) {
      revenueByChannel[sale.channel] = round2(revenueByChannel[sale.channel] + sale.revenue);
    }
    return {
      year,
      products,
      totals: {
        // Includes sales that reference a missing product; per-product rows
        // cannot, so this can exceed the sum of the rows.
        revenue: sumRevenue(yearSales),
        revenueByChannel,
        totalCosts: round2(yearCosts.reduce((sum, cost) => sum + cost.amount, 0)),
        grossMargin: round2(sumRevenue(yearSales) - yearCosts.reduce((sum, cost) => sum + cost.amount, 0)),
        cogsEstimate: round2(products.reduce((sum, row) => sum + row.cogsEstimate, 0)),
        inventoryValue: round2(products.reduce((sum, row) => sum + row.inventoryValue, 0)),
      },
    };
  };

  const current = buildYear(currentYear);
  const prior = buildYear(priorYear);

  const unlinked = profile.sales.filter(sale =>
    recordYear(sale.date) === currentYear && !sale.transactionGuid?.trim());
  const missingProducts = [
    ...profile.harvests
      .filter(harvest => !productIds.has(harvest.productId))
      .map(harvest => ({ recordType: 'harvest' as const, id: harvest.id, date: harvest.date, productId: harvest.productId })),
    ...profile.sales
      .filter(sale => !productIds.has(sale.productId))
      .map(sale => ({ recordType: 'sale' as const, id: sale.id, date: sale.date, productId: sale.productId })),
  ];
  const negativeStock = current.products
    .filter(row => row.onHandQty < 0)
    .map(row => ({ productId: row.productId, name: row.name, unit: row.unit, onHandQty: row.onHandQty }));
  const flags = {
    negativeStock,
    unlinkedSales: { count: unlinked.length, revenue: sumRevenue(unlinked) },
    missingProducts,
    issueCount: negativeStock.length + missingProducts.length + unlinked.length,
  };

  let marketDays: {
    dayOfWeek: number;
    nextDates: string[];
    marketDaysThisYear: number;
    averageRevenuePerMarketDay: number;
  } | null = null;
  if (settings.defaultMarketDay != null) {
    const start = new Date(`${asOfDate}T12:00:00Z`);
    const offset = (settings.defaultMarketDay - start.getUTCDay() + 7) % 7;
    const nextDates = Array.from({ length: MARKET_DAYS_AHEAD }, (_, index) =>
      new Date(start.getTime() + (offset + index * 7) * MS_PER_DAY).toISOString().slice(0, 10));
    const marketSales = profile.sales.filter(sale =>
      recordYear(sale.date) === currentYear && sale.channel === 'farmers_market');
    const marketDates = new Set(marketSales.map(sale => sale.date));
    marketDays = {
      dayOfWeek: settings.defaultMarketDay,
      nextDates,
      marketDaysThisYear: marketDates.size,
      averageRevenuePerMarketDay: marketDates.size > 0
        ? round2(sumRevenue(marketSales) / marketDates.size)
        : 0,
    };
  }

  const scheduleF = {
    /** Current-year sales revenue in Schedule F line 2 context. */
    salesRevenue: current.totals.revenue,
    priorSalesRevenue: prior.totals.revenue,
    directCosts: current.totals.totalCosts,
    assumptions: [
      'All sales are treated as sales of raised products (Schedule F line 2); no resale (lines 1a-1c) distinction is made.',
      'Costs entered here are planning inputs that should reconcile with ledger expense accounts; this tracker does not post to the ledger.',
      'Inventory value is unit cost times on-hand quantity, a planning estimate rather than a tax-basis inventory.',
    ],
    notes: settings.scheduleFNotes?.trim() || null,
  };

  return {
    settings,
    asOfDate,
    currentYear,
    priorYear,
    current,
    prior,
    flags,
    marketDays,
    scheduleF,
  };
}
