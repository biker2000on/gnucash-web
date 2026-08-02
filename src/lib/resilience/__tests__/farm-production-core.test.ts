import { describe, expect, it } from 'vitest';
import { calculateFarmProduction } from '../farm-production-core';
import type { FarmProductionProfile, FarmProductionSettings } from '../types';

const asOf = new Date('2026-08-01T12:00:00Z');

const settings: FarmProductionSettings = {
  scheduleFNotes: null,
  defaultMarketDay: null,
};

const emptyProfile: FarmProductionProfile = {
  products: [],
  harvests: [],
  sales: [],
  adjustments: [],
  costs: [],
  settings,
};

describe('calculateFarmProduction', () => {
  it('computes per-product production, sales, carry-over on-hand, and revenue-share cost allocation', () => {
    const profile: FarmProductionProfile = {
      products: [
        { id: 'p-honey', name: 'Wildflower Honey', unit: 'jar', category: 'honey', targetPrice: 12 },
        { id: 'p-eggs', name: 'Pasture Eggs', unit: 'dozen', category: 'eggs' },
      ],
      harvests: [
        { id: 'h1', date: '2026-06-15', productId: 'p-honey', quantity: 100, source: 'manual' },
        { id: 'h2', date: '2026-07-01', productId: 'p-honey', quantity: 20, notes: 'Second pull', source: 'manual' },
        { id: 'h3', date: '2025-06-15', productId: 'p-honey', quantity: 50, source: 'manual' },
        { id: 'h4', date: '2026-04-01', productId: 'p-eggs', quantity: 200, source: 'manual' },
      ],
      sales: [
        { id: 's1', date: '2026-07-04', productId: 'p-honey', channel: 'farmers_market', quantity: 60, revenue: 720, transactionGuid: 'a'.repeat(32), source: 'manual' },
        { id: 's2', date: '2026-07-10', productId: 'p-honey', channel: 'direct', quantity: 10, revenue: 130, transactionGuid: 'b'.repeat(32), source: 'manual' },
        { id: 's3', date: '2026-05-20', productId: 'p-eggs', channel: 'csa', quantity: 150, revenue: 600, transactionGuid: 'c'.repeat(32), source: 'manual' },
        { id: 's4', date: '2025-09-01', productId: 'p-honey', channel: 'wholesale', quantity: 30, revenue: 240, source: 'manual' },
      ],
      adjustments: [
        { id: 'a1', date: '2026-07-20', productId: 'p-honey', quantityDelta: -5, reason: 'Spoiled jars' },
      ],
      costs: [
        { id: 'c1', year: 2026, productId: 'p-honey', label: 'Jars & lids', amount: 130 },
        { id: 'c2', year: 2026, productId: null, label: 'Feed & supplies', amount: 300 },
        { id: 'c3', year: 2025, productId: null, label: 'Feed', amount: 100 },
      ],
      settings,
    };
    const result = calculateFarmProduction(profile, asOf);
    expect(result.currentYear).toBe(2026);
    expect(result.priorYear).toBe(2025);
    expect(result.asOfDate).toBe('2026-08-01');

    const [honey, eggs] = result.current.products;
    expect(honey.producedQty).toBe(120);
    expect(honey.soldQty).toBe(70);
    expect(honey.adjustmentQty).toBe(-5);
    // On-hand carries the 2025 harvest and sale forward: 170 - 5 - 100.
    expect(honey.onHandQty).toBe(65);
    expect(honey.revenue).toBe(850);
    expect(honey.revenueByChannel).toEqual({ farmers_market: 720, wholesale: 0, direct: 130, csa: 0, other: 0 });
    // 130 specific + 300 × (850 / 1450) = 305.86.
    expect(honey.allocatedCost).toBe(305.86);
    expect(honey.unitCost).toBe(2.55);
    expect(honey.grossMargin).toBe(544.14);
    expect(honey.marginPercent).toBe(64.02);
    expect(honey.cogsEstimate).toBe(178.5);
    expect(honey.inventoryValue).toBe(165.75);

    expect(eggs.producedQty).toBe(200);
    expect(eggs.soldQty).toBe(150);
    expect(eggs.onHandQty).toBe(50);
    expect(eggs.revenue).toBe(600);
    // 300 × (600 / 1450) = 124.14.
    expect(eggs.allocatedCost).toBe(124.14);
    expect(eggs.unitCost).toBe(0.62);
    expect(eggs.grossMargin).toBe(475.86);
    expect(eggs.marginPercent).toBe(79.31);
    expect(eggs.cogsEstimate).toBe(93);
    expect(eggs.inventoryValue).toBe(31);

    expect(result.current.totals.revenue).toBe(1450);
    expect(result.current.totals.revenueByChannel).toEqual({ farmers_market: 720, wholesale: 0, direct: 130, csa: 600, other: 0 });
    expect(result.current.totals.totalCosts).toBe(430);
    expect(result.current.totals.grossMargin).toBe(1020);
    expect(result.current.totals.cogsEstimate).toBe(271.5);
    expect(result.current.totals.inventoryValue).toBe(196.75);

    // Prior year: honey is the only revenue, so it absorbs the whole-farm cost.
    const [priorHoney, priorEggs] = result.prior.products;
    expect(priorHoney.producedQty).toBe(50);
    expect(priorHoney.soldQty).toBe(30);
    expect(priorHoney.onHandQty).toBe(20);
    expect(priorHoney.revenue).toBe(240);
    expect(priorHoney.allocatedCost).toBe(100);
    expect(priorHoney.unitCost).toBe(2);
    expect(priorHoney.grossMargin).toBe(140);
    expect(priorHoney.marginPercent).toBe(58.33);
    expect(priorHoney.cogsEstimate).toBe(60);
    expect(priorHoney.inventoryValue).toBe(40);
    expect(priorEggs.producedQty).toBe(0);
    expect(priorEggs.allocatedCost).toBe(0);
    expect(priorEggs.unitCost).toBe(0);
    expect(priorEggs.inventoryValue).toBe(0);
    expect(result.prior.totals.revenue).toBe(240);
    expect(result.prior.totals.totalCosts).toBe(100);
    expect(result.prior.totals.grossMargin).toBe(140);
    expect(result.prior.totals.cogsEstimate).toBe(60);
    expect(result.prior.totals.inventoryValue).toBe(40);

    // The unlinked 2025 sale is outside the current year and raises no flag.
    expect(result.flags.negativeStock).toEqual([]);
    expect(result.flags.unlinkedSales).toEqual({ count: 0, revenue: 0 });
    expect(result.flags.missingProducts).toEqual([]);
    expect(result.flags.issueCount).toBe(0);
  });

  it('allocates whole-farm costs by produced-quantity share when there is no revenue', () => {
    const result = calculateFarmProduction({
      ...emptyProfile,
      products: [
        { id: 'p-a', name: 'Blueberries', unit: 'lb', category: 'produce' },
        { id: 'p-b', name: 'Blackberries', unit: 'lb', category: 'produce' },
      ],
      harvests: [
        { id: 'h1', date: '2026-06-01', productId: 'p-a', quantity: 30, source: 'manual' },
        { id: 'h2', date: '2026-06-02', productId: 'p-b', quantity: 10, source: 'manual' },
      ],
      costs: [
        { id: 'c1', year: 2026, productId: null, label: 'Netting', amount: 200 },
      ],
    }, asOf);
    const [a, b] = result.current.products;
    expect(a.allocatedCost).toBe(150);
    expect(a.unitCost).toBe(5);
    expect(a.grossMargin).toBe(-150);
    expect(a.marginPercent).toBe(0);
    expect(a.inventoryValue).toBe(150);
    expect(b.allocatedCost).toBe(50);
    expect(b.unitCost).toBe(5);
    expect(b.inventoryValue).toBe(50);
    expect(result.current.totals.totalCosts).toBe(200);
    expect(result.current.totals.grossMargin).toBe(-200);
  });

  it('leaves whole-farm costs unallocated when there is neither revenue nor production', () => {
    const result = calculateFarmProduction({
      ...emptyProfile,
      products: [{ id: 'p-a', name: 'Honey', unit: 'jar', category: 'honey' }],
      costs: [{ id: 'c1', year: 2026, productId: null, label: 'Hive upkeep', amount: 400 }],
    }, asOf);
    expect(result.current.products[0].allocatedCost).toBe(0);
    expect(result.current.products[0].unitCost).toBe(0);
    expect(result.current.totals.totalCosts).toBe(400);
    expect(result.current.totals.grossMargin).toBe(-400);
  });

  it('reports negative on-hand without flooring, unlinked sales, and missing product references', () => {
    const result = calculateFarmProduction({
      ...emptyProfile,
      products: [{ id: 'p-honey', name: 'Honey', unit: 'jar', category: 'honey' }],
      harvests: [
        { id: 'h1', date: '2026-05-01', productId: 'p-honey', quantity: 10, source: 'manual' },
        { id: 'h2', date: '2026-05-02', productId: 'p-ghost', quantity: 3, source: 'manual' },
      ],
      sales: [
        { id: 's1', date: '2026-06-01', productId: 'p-honey', channel: 'farmers_market', quantity: 18, revenue: 90, source: 'manual' },
        { id: 's2', date: '2026-06-02', productId: 'p-ghost', channel: 'direct', quantity: 5, revenue: 50, transactionGuid: 'd'.repeat(32), source: 'manual' },
      ],
    }, asOf);
    const [honey] = result.current.products;
    expect(honey.onHandQty).toBe(-8);
    expect(honey.inventoryValue).toBe(0);
    expect(honey.grossMargin).toBe(90);
    expect(honey.marginPercent).toBe(100);
    // Whole-farm totals still count the orphaned sale's revenue.
    expect(result.current.totals.revenue).toBe(140);
    expect(result.flags.negativeStock).toEqual([
      { productId: 'p-honey', name: 'Honey', unit: 'jar', onHandQty: -8 },
    ]);
    expect(result.flags.unlinkedSales).toEqual({ count: 1, revenue: 90 });
    expect(result.flags.missingProducts).toEqual([
      { recordType: 'harvest', id: 'h2', date: '2026-05-02', productId: 'p-ghost' },
      { recordType: 'sale', id: 's2', date: '2026-06-02', productId: 'p-ghost' },
    ]);
    expect(result.flags.issueCount).toBe(4);
  });

  it('projects the next four market days and averages farmers-market revenue per market day', () => {
    // 2026-08-01 is a Saturday (UTC day 6).
    const result = calculateFarmProduction({
      ...emptyProfile,
      products: [{ id: 'p-honey', name: 'Honey', unit: 'jar', category: 'honey' }],
      sales: [
        { id: 's1', date: '2026-07-04', productId: 'p-honey', channel: 'farmers_market', quantity: 10, revenue: 200, transactionGuid: 'a'.repeat(32), source: 'manual' },
        { id: 's2', date: '2026-07-04', productId: 'p-honey', channel: 'farmers_market', quantity: 5, revenue: 100, transactionGuid: 'b'.repeat(32), source: 'manual' },
        { id: 's3', date: '2026-07-11', productId: 'p-honey', channel: 'farmers_market', quantity: 3, revenue: 60, transactionGuid: 'c'.repeat(32), source: 'manual' },
        { id: 's4', date: '2026-07-12', productId: 'p-honey', channel: 'direct', quantity: 2, revenue: 40, transactionGuid: 'd'.repeat(32), source: 'manual' },
        { id: 's5', date: '2025-07-05', productId: 'p-honey', channel: 'farmers_market', quantity: 4, revenue: 80, transactionGuid: 'e'.repeat(32), source: 'manual' },
      ],
      settings: { ...settings, defaultMarketDay: 6 },
    }, asOf);
    expect(result.marketDays).toEqual({
      dayOfWeek: 6,
      nextDates: ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22'],
      marketDaysThisYear: 2,
      averageRevenuePerMarketDay: 180,
    });

    const wednesday = calculateFarmProduction({
      ...emptyProfile,
      settings: { ...settings, defaultMarketDay: 3 },
    }, asOf);
    expect(wednesday.marketDays).toEqual({
      dayOfWeek: 3,
      nextDates: ['2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26'],
      marketDaysThisYear: 0,
      averageRevenuePerMarketDay: 0,
    });

    expect(calculateFarmProduction(emptyProfile, asOf).marketDays).toBeNull();
  });

  it('shapes Schedule F context with the raised-products and ledger-reconciliation assumptions', () => {
    const result = calculateFarmProduction({
      ...emptyProfile,
      products: [{ id: 'p-honey', name: 'Honey', unit: 'jar', category: 'honey' }],
      sales: [
        { id: 's1', date: '2026-03-01', productId: 'p-honey', channel: 'wholesale', quantity: 20, revenue: 300, transactionGuid: 'a'.repeat(32), source: 'manual' },
        { id: 's2', date: '2025-03-01', productId: 'p-honey', channel: 'wholesale', quantity: 10, revenue: 150, transactionGuid: 'b'.repeat(32), source: 'manual' },
      ],
      costs: [{ id: 'c1', year: 2026, productId: null, label: 'Feed', amount: 90 }],
      settings: { ...settings, scheduleFNotes: '  Report with the LLC book.  ' },
    }, asOf);
    expect(result.scheduleF.salesRevenue).toBe(300);
    expect(result.scheduleF.priorSalesRevenue).toBe(150);
    expect(result.scheduleF.directCosts).toBe(90);
    expect(result.scheduleF.notes).toBe('Report with the LLC book.');
    expect(result.scheduleF.assumptions).toEqual([
      'All sales are treated as sales of raised products (Schedule F line 2); no resale (lines 1a-1c) distinction is made.',
      'Costs entered here are planning inputs that should reconcile with ledger expense accounts; this tracker does not post to the ledger.',
      'Inventory value is unit cost times on-hand quantity, a planning estimate rather than a tax-basis inventory.',
    ]);
    expect(result.scheduleF.notes).not.toBeNull();
  });

  it('returns an empty deterministic shape for an empty profile', () => {
    const result = calculateFarmProduction(emptyProfile, asOf);
    expect(result.current.products).toEqual([]);
    expect(result.current.totals).toEqual({
      revenue: 0,
      revenueByChannel: { farmers_market: 0, wholesale: 0, direct: 0, csa: 0, other: 0 },
      totalCosts: 0,
      grossMargin: 0,
      cogsEstimate: 0,
      inventoryValue: 0,
    });
    expect(result.prior.totals.revenue).toBe(0);
    expect(result.flags.issueCount).toBe(0);
    expect(result.marketDays).toBeNull();
    expect(result.scheduleF.salesRevenue).toBe(0);
    expect(result.scheduleF.notes).toBeNull();
  });
});
