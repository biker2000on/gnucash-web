'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { calculateFarmProduction } from '@/lib/resilience/farm-production-core';
import type {
  FarmAdjustment,
  FarmCost,
  FarmHarvest,
  FarmProduct,
  FarmProductionProfile,
  FarmProductionSettings,
  FarmSale,
} from '@/lib/resilience/types';
import { Empty, Field, INPUT, Metric, Panel, SaveBar, TNUM } from './ui';

const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const numberValue = (value: string) => Number(value) || 0;

type FarmProduction = ReturnType<typeof calculateFarmProduction>;
type FarmResponse = { profile: FarmProductionProfile; production: FarmProduction };

const DEFAULT_SETTINGS: FarmProductionSettings = {
  scheduleFNotes: null,
  defaultMarketDay: null,
};

const CATEGORY_LABELS: Record<FarmProduct['category'], string> = {
  honey: 'Honey',
  eggs: 'Eggs',
  produce: 'Produce',
  meat: 'Meat',
  value_added: 'Value-added',
  other: 'Other',
};

const CHANNEL_LABELS: Record<FarmSale['channel'], string> = {
  farmers_market: 'Farmers market',
  wholesale: 'Wholesale',
  direct: 'Direct',
  csa: 'CSA',
  other: 'Other',
};

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function useSection<P, R extends { profile: P }>(section: string, initial: P) {
  const toast = useToast();
  const [response, setResponse] = useState<R | null>(null);
  const [profile, setProfile] = useState<P>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const result = await fetch(`/api/resilience/${section}`, { cache: 'no-store' });
    const json = await result.json();
    if (!result.ok) throw new Error(json.error || 'Request failed');
    setResponse(json as R);
    setProfile((json as R).profile);
    setDirty(false);
  };

  useEffect(() => {
    load().catch(() => toast.error(`Failed to load ${section.replaceAll('_', ' ')}`)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  const change = (next: P) => {
    setProfile(next);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await fetch(`/api/resilience/${section}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const json = await result.json();
      if (!result.ok) throw new Error(json.error || 'Save failed');
      setResponse(json as R);
      setProfile((json as R).profile);
      setDirty(false);
      toast.success('Changes saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return { response, profile, change, dirty, saving, loading, save };
}

function SourceBadge(props: { source: 'manual' | 'beez_trackz' }) {
  if (props.source === 'manual') return null;
  return (
    <span className="rounded border border-secondary/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-secondary">
      Beez Trackz — synced, delete only
    </span>
  );
}

export function FarmProductionPage() {
  const state = useSection<FarmProductionProfile, FarmResponse>('farm_production', {
    products: [],
    harvests: [],
    sales: [],
    adjustments: [],
    costs: [],
    settings: DEFAULT_SETTINGS,
  });
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading farm production…</div>;
  const production = state.response?.production;
  const productIds = new Set(state.profile.products.map(product => product.id));
  const firstProductId = state.profile.products[0]?.id ?? '';
  const hasProducts = state.profile.products.length > 0;

  const updateProduct = (id: string, patch: Partial<FarmProduct>) =>
    state.change({ ...state.profile, products: state.profile.products.map(item => item.id === id ? { ...item, ...patch } : item) });
  const updateHarvest = (id: string, patch: Partial<FarmHarvest>) =>
    state.change({ ...state.profile, harvests: state.profile.harvests.map(item => item.id === id ? { ...item, ...patch } : item) });
  const updateSale = (id: string, patch: Partial<FarmSale>) =>
    state.change({ ...state.profile, sales: state.profile.sales.map(item => item.id === id ? { ...item, ...patch } : item) });
  const updateAdjustment = (id: string, patch: Partial<FarmAdjustment>) =>
    state.change({ ...state.profile, adjustments: state.profile.adjustments.map(item => item.id === id ? { ...item, ...patch } : item) });
  const updateCost = (id: string, patch: Partial<FarmCost>) =>
    state.change({ ...state.profile, costs: state.profile.costs.map(item => item.id === id ? { ...item, ...patch } : item) });
  const updateSettings = (patch: Partial<FarmProductionSettings>) =>
    state.change({ ...state.profile, settings: { ...state.profile.settings, ...patch } });

  const addProduct = () => state.change({
    ...state.profile,
    products: [...state.profile.products, { id: uid(), name: '', unit: 'lb', category: 'other', targetPrice: null }],
  });
  const addHarvest = () => state.change({
    ...state.profile,
    harvests: [...state.profile.harvests, { id: uid(), date: today(), productId: firstProductId, quantity: 0, notes: null, source: 'manual', sourceId: null }],
  });
  const addSale = () => state.change({
    ...state.profile,
    sales: [...state.profile.sales, { id: uid(), date: today(), productId: firstProductId, channel: 'farmers_market', quantity: 0, revenue: 0, transactionGuid: null, source: 'manual', sourceId: null }],
  });
  const addAdjustment = () => state.change({
    ...state.profile,
    adjustments: [...state.profile.adjustments, { id: uid(), date: today(), productId: firstProductId, quantityDelta: 0, reason: null }],
  });
  const addCost = () => state.change({
    ...state.profile,
    costs: [...state.profile.costs, { id: uid(), year: new Date().getUTCFullYear(), productId: null, label: '', amount: 0 }],
  });

  const productSelect = (value: string, disabled: boolean, onChange: (next: string) => void) => (
    <select className={INPUT} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      {!productIds.has(value) && <option value={value}>{value ? 'Unknown product' : 'Select product'}</option>}
      {state.profile.products.map(product => <option key={product.id} value={product.id}>{product.name || 'Unnamed product'}</option>)}
    </select>
  );

  const totals = production?.current.totals;
  const marginPercent = totals && totals.revenue > 0 ? totals.grossMargin / totals.revenue * 100 : null;
  const addRecordButton = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      disabled={!hasProducts}
      title={hasProducts ? undefined : 'Add a product first'}
      className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Farm Production & Direct-Sales COGS"
        subtitle="Harvests, sales by channel, stock on hand, allocated input costs, and per-product margins with Schedule F context."
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Metric label={`${production?.currentYear ?? new Date().getUTCFullYear()} revenue`} value={formatCurrency(totals?.revenue ?? 0)} />
        <Metric
          label="Gross margin"
          value={marginPercent == null ? '—' : `${marginPercent.toFixed(1)}%`}
          tone={marginPercent == null ? undefined : marginPercent >= 20 ? 'positive' : marginPercent >= 0 ? 'warning' : 'negative'}
        />
        <Metric label="Inventory value" value={formatCurrency(totals?.inventoryValue ?? 0)} />
        <Metric
          label="Data issues"
          value={production?.flags.issueCount ?? 0}
          tone={(production?.flags.issueCount ?? 0) > 0 ? 'warning' : 'positive'}
        />
      </div>

      <Panel
        title="Products"
        description="Everything the farm sells, with the unit each harvest and sale is measured in."
        action={<button type="button" onClick={addProduct} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add product</button>}
      >
        {state.profile.products.length === 0 ? <Empty>Add each product first — honey, eggs, produce — then record harvests and sales against it.</Empty> : (
          <div className="space-y-2">
            {state.profile.products.map(product => (
              <div key={product.id} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 md:grid-cols-[1fr_120px_160px_140px_auto]">
                <input className={INPUT} placeholder="Product (e.g. Wildflower honey)" value={product.name} onChange={event => updateProduct(product.id, { name: event.target.value })} />
                <input className={INPUT} placeholder="Unit (lb, dozen, jar)" value={product.unit} onChange={event => updateProduct(product.id, { unit: event.target.value })} />
                <select className={INPUT} value={product.category} onChange={event => updateProduct(product.id, { category: event.target.value as FarmProduct['category'] })}>
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <input type="number" min={0} step={0.01} className={`${INPUT} font-mono`} title="Target price per unit" placeholder="Target price" value={product.targetPrice ?? ''} onChange={event => updateProduct(product.id, { targetPrice: event.target.value === '' ? null : numberValue(event.target.value) })} />
                <button type="button" onClick={() => state.change({ ...state.profile, products: state.profile.products.filter(item => item.id !== product.id) })} className="px-2 text-negative">×</button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Harvests"
        description="Quantities brought in, measured in the unit of each product. Synced records will arrive read-only except delete."
        action={addRecordButton('Add harvest', addHarvest)}
      >
        {state.profile.harvests.length === 0 ? <Empty>Record each harvest — a honey pull, the morning eggs, a picking — to build produced quantities.</Empty> : (
          <div className="space-y-2">
            {state.profile.harvests.slice().sort((a, b) => b.date.localeCompare(a.date)).map(harvest => {
              const locked = harvest.source !== 'manual';
              return (
                <div key={harvest.id} className="space-y-2 rounded-md border border-border p-3">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-[140px_1fr_120px_1fr_auto]">
                    <input type="date" className={`${INPUT} font-mono`} disabled={locked} value={harvest.date} onChange={event => updateHarvest(harvest.id, { date: event.target.value })} />
                    {productSelect(harvest.productId, locked, next => updateHarvest(harvest.id, { productId: next }))}
                    <input type="number" min={0} step={0.01} className={`${INPUT} font-mono`} title="Quantity" disabled={locked} value={harvest.quantity} onChange={event => updateHarvest(harvest.id, { quantity: numberValue(event.target.value) })} />
                    <input className={INPUT} placeholder="Notes (optional)" disabled={locked} value={harvest.notes ?? ''} onChange={event => updateHarvest(harvest.id, { notes: event.target.value || null })} />
                    <button type="button" onClick={() => state.change({ ...state.profile, harvests: state.profile.harvests.filter(item => item.id !== harvest.id) })} className="px-2 text-negative">×</button>
                  </div>
                  <SourceBadge source={harvest.source} />
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel
        title="Sales"
        description="Total revenue per sale, not per-unit price. Link the GnuCash transaction so Schedule F income reconciles to the ledger."
        action={addRecordButton('Add sale', addSale)}
      >
        {state.profile.sales.length === 0 ? <Empty>Record each sale with its channel — farmers market, wholesale, direct, CSA.</Empty> : (
          <div className="space-y-2">
            {state.profile.sales.slice().sort((a, b) => b.date.localeCompare(a.date)).map(sale => {
              const locked = sale.source !== 'manual';
              return (
                <div key={sale.id} className="space-y-2 rounded-md border border-border p-3">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-[140px_1fr_150px_100px_120px_1fr_auto]">
                    <input type="date" className={`${INPUT} font-mono`} disabled={locked} value={sale.date} onChange={event => updateSale(sale.id, { date: event.target.value })} />
                    {productSelect(sale.productId, locked, next => updateSale(sale.id, { productId: next }))}
                    <select className={INPUT} disabled={locked} value={sale.channel} onChange={event => updateSale(sale.id, { channel: event.target.value as FarmSale['channel'] })}>
                      {Object.entries(CHANNEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <input type="number" min={0} step={0.01} className={`${INPUT} font-mono`} title="Quantity" disabled={locked} value={sale.quantity} onChange={event => updateSale(sale.id, { quantity: numberValue(event.target.value) })} />
                    <input type="number" min={0} step={0.01} className={`${INPUT} font-mono`} title="Total revenue" disabled={locked} value={sale.revenue} onChange={event => updateSale(sale.id, { revenue: numberValue(event.target.value) })} />
                    <input className={`${INPUT} font-mono`} placeholder="Transaction GUID (optional)" maxLength={32} value={sale.transactionGuid ?? ''} onChange={event => updateSale(sale.id, { transactionGuid: event.target.value || null })} />
                    <button type="button" onClick={() => state.change({ ...state.profile, sales: state.profile.sales.filter(item => item.id !== sale.id) })} className="px-2 text-negative">×</button>
                  </div>
                  <SourceBadge source={sale.source} />
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel
        title="Adjustments"
        description="Signed stock corrections outside harvests and sales — spoilage negative, found stock positive."
        action={addRecordButton('Add adjustment', addAdjustment)}
      >
        {state.profile.adjustments.length === 0 ? <Empty>Record spoilage, breakage, home use, or count corrections so on-hand stays honest.</Empty> : (
          <div className="space-y-2">
            {state.profile.adjustments.slice().sort((a, b) => b.date.localeCompare(a.date)).map(adjustment => (
              <div key={adjustment.id} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 md:grid-cols-[140px_1fr_120px_1fr_auto]">
                <input type="date" className={`${INPUT} font-mono`} value={adjustment.date} onChange={event => updateAdjustment(adjustment.id, { date: event.target.value })} />
                {productSelect(adjustment.productId, false, next => updateAdjustment(adjustment.id, { productId: next }))}
                <input type="number" step={0.01} className={`${INPUT} font-mono`} title="Quantity delta (signed)" value={adjustment.quantityDelta} onChange={event => updateAdjustment(adjustment.id, { quantityDelta: numberValue(event.target.value) })} />
                <input className={INPUT} placeholder="Reason (optional)" value={adjustment.reason ?? ''} onChange={event => updateAdjustment(adjustment.id, { reason: event.target.value || null })} />
                <button type="button" onClick={() => state.change({ ...state.profile, adjustments: state.profile.adjustments.filter(item => item.id !== adjustment.id) })} className="px-2 text-negative">×</button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Direct input costs"
        description="Annual costs like jars, feed, and packaging. Whole-farm costs allocate across products by revenue share (produced share when there is no revenue)."
        action={<button type="button" onClick={addCost} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add cost</button>}
      >
        {state.profile.costs.length === 0 ? <Empty>Add annual input costs per product, or whole-farm costs shared across everything.</Empty> : (
          <div className="space-y-2">
            {state.profile.costs.slice().sort((a, b) => b.year - a.year).map(cost => (
              <div key={cost.id} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 md:grid-cols-[110px_1fr_1fr_140px_auto]">
                <input type="number" min={1900} max={2300} className={`${INPUT} font-mono`} title="Year" value={cost.year} onChange={event => updateCost(cost.id, { year: numberValue(event.target.value) })} />
                <select className={INPUT} value={cost.productId ?? ''} onChange={event => updateCost(cost.id, { productId: event.target.value || null })}>
                  <option value="">Whole farm</option>
                  {state.profile.products.map(product => <option key={product.id} value={product.id}>{product.name || 'Unnamed product'}</option>)}
                </select>
                <input className={INPUT} placeholder="Label (jars, feed, packaging)" value={cost.label} onChange={event => updateCost(cost.id, { label: event.target.value })} />
                <input type="number" min={0} step={0.01} className={`${INPUT} font-mono`} title="Annual amount" value={cost.amount} onChange={event => updateCost(cost.id, { amount: numberValue(event.target.value) })} />
                <button type="button" onClick={() => state.change({ ...state.profile, costs: state.profile.costs.filter(item => item.id !== cost.id) })} className="px-2 text-negative">×</button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title={`Per-product results — ${production?.currentYear ?? new Date().getUTCFullYear()}`}
        description="Produced, sold, and on-hand quantities with allocated unit cost and gross margin. Negative on-hand is a data-quality signal."
      >
        {!production || production.current.products.length === 0 ? <Empty>Save products and records to compute per-product results.</Empty> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3 text-right">Produced</th>
                    <th className="py-2 pr-3 text-right">Sold</th>
                    <th className="py-2 pr-3 text-right">Adjustments</th>
                    <th className="py-2 pr-3 text-right">On hand</th>
                    <th className="py-2 pr-3 text-right">Unit cost</th>
                    <th className="py-2 pr-3 text-right">Revenue</th>
                    <th className="py-2 pr-3 text-right">Margin</th>
                    <th className="py-2 pr-3 text-right">Margin %</th>
                    <th className="py-2 text-right">Inventory value</th>
                  </tr>
                </thead>
                <tbody>
                  {production.current.products.map(row => (
                    <tr key={row.productId} className="border-b border-border/60">
                      <td className="py-2 pr-3 text-foreground">{row.name || 'Unnamed product'} <span className="text-xs text-foreground-muted">/ {row.unit}</span></td>
                      <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{row.producedQty}</td>
                      <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{row.soldQty}</td>
                      <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{row.adjustmentQty}</td>
                      <td className={`py-2 pr-3 text-right font-mono ${row.onHandQty < 0 ? 'text-negative' : ''}`} style={TNUM}>{row.onHandQty}</td>
                      <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{formatCurrency(row.unitCost)}</td>
                      <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{formatCurrency(row.revenue)}</td>
                      <td className={`py-2 pr-3 text-right font-mono ${row.grossMargin < 0 ? 'text-negative' : 'text-positive'}`} style={TNUM}>{formatCurrency(row.grossMargin)}</td>
                      <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{row.revenue > 0 ? `${row.marginPercent.toFixed(1)}%` : '—'}</td>
                      <td className="py-2 text-right font-mono" style={TNUM}>{formatCurrency(row.inventoryValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-foreground-muted">
              Prior year ({production.priorYear}): {formatCurrency(production.prior.totals.revenue)} revenue,
              {' '}{formatCurrency(production.prior.totals.totalCosts)} costs,
              {' '}{formatCurrency(production.prior.totals.grossMargin)} gross margin.
              Whole-farm COGS estimate for sold units this year: {formatCurrency(production.current.totals.cogsEstimate)}.
            </p>
            {production.flags.negativeStock.length > 0 && (
              <p className="mt-2 text-xs text-warning">
                Negative on-hand: {production.flags.negativeStock.map(item => `${item.name} (${item.onHandQty} ${item.unit})`).join(', ')} — check for missing harvests or duplicate sales.
              </p>
            )}
            {production.flags.unlinkedSales.count > 0 && (
              <p className="mt-1 text-xs text-warning">
                {production.flags.unlinkedSales.count} current-year sale{production.flags.unlinkedSales.count === 1 ? '' : 's'} totaling {formatCurrency(production.flags.unlinkedSales.revenue)} have no linked GnuCash transaction.
              </p>
            )}
            {production.flags.missingProducts.length > 0 && (
              <p className="mt-1 text-xs text-warning">
                {production.flags.missingProducts.length} record{production.flags.missingProducts.length === 1 ? '' : 's'} reference a deleted product and are excluded from per-product rows.
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel title="Schedule F context" description="Planning totals shaped for the farm return, plus the market-day cadence used on the money timeline.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Sales of raised products" value={formatCurrency(production?.scheduleF.salesRevenue ?? 0)} />
          <Metric label={`Prior year (${production?.priorYear ?? '—'})`} value={formatCurrency(production?.scheduleF.priorSalesRevenue ?? 0)} />
          <Metric label="Direct input costs" value={formatCurrency(production?.scheduleF.directCosts ?? 0)} />
          <Metric label="Inventory value" value={formatCurrency(totals?.inventoryValue ?? 0)} />
        </div>
        <ul className="mt-3 list-disc pl-4 text-xs text-foreground-muted">
          {(production?.scheduleF.assumptions ?? []).map(assumption => <li key={assumption}>{assumption}</li>)}
        </ul>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[220px_1fr]">
          <Field label="Regular market day">
            <select
              className={INPUT}
              value={state.profile.settings.defaultMarketDay ?? ''}
              onChange={event => updateSettings({ defaultMarketDay: event.target.value === '' ? null : Number(event.target.value) })}
            >
              <option value="">None</option>
              {WEEKDAY_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}
            </select>
          </Field>
          <Field label="Schedule F notes">
            <input className={INPUT} placeholder="Notes for the preparer (optional)" value={state.profile.settings.scheduleFNotes ?? ''} onChange={event => updateSettings({ scheduleFNotes: event.target.value || null })} />
          </Field>
        </div>
        {production?.marketDays && (
          <p className="mt-3 text-xs text-foreground-muted">
            Next market days: {production.marketDays.nextDates.join(', ')} — averaging {formatCurrency(production.marketDays.averageRevenuePerMarketDay)} per market day across {production.marketDays.marketDaysThisYear} market day{production.marketDays.marketDaysThisYear === 1 ? '' : 's'} this year.
          </p>
        )}
        <p className="mt-2 text-xs text-foreground-muted">Planning estimate, not tax advice. This tracker does not post to the ledger.</p>
      </Panel>

      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}
