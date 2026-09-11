'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCurrency } from '@/lib/format';
import { buildUtilityTrends } from '@/lib/resilience/utility-trends';
import type { UtilityBill, UtilityType } from '@/lib/resilience/types';
import { SELECT } from '@/components/ui/form';
import { Empty, Field, INPUT, Panel } from './ui';

const unitLabels: Record<UtilityBill['unit'], string> = { kWh: 'kilowatt-hours', therms: 'therms', gallons: 'gallons' };
const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const numeric = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const change = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatCurrency(Math.abs(value))}`;

type ChartPoint = { month: string; value: number | null };
function TrendChart({ data, label, money = false }: { data: ChartPoint[]; label: string; money?: boolean }) {
  return (
    <div className="h-64 min-w-0" role="group" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 12, bottom: 8, left: 8 }} accessibilityLayer>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: 'var(--foreground-muted)', fontSize: 12 }} minTickGap={24} />
          <YAxis width={64} tickFormatter={value => money ? `$${numeric(value)}` : numeric(value)} tick={{ fill: 'var(--foreground-muted)', fontSize: 12, fontFamily: 'var(--font-mono)' }} />
          <Tooltip labelFormatter={value => monthLabel(String(value))} formatter={value => [money ? formatCurrency(Number(value)) : numeric(Number(value)), label]}
            contentStyle={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--foreground)', fontSize: 13 }} />
          <Line type="linear" dataKey="value" name={label} stroke="var(--primary)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function UtilityTrends({ bills, dirty }: { bills: UtilityBill[]; dirty: boolean }) {
  const [type, setType] = useState<UtilityType>(bills[0]?.type ?? 'electric');
  const [provider, setProvider] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [feeId, setFeeId] = useState('total');
  const providers = useMemo(() => [...new Set(bills.filter(bill => bill.type === type).map(bill => bill.provider))].sort(), [bills, type]);
  const trends = useMemo(() => buildUtilityTrends(bills, { type, provider, from, to }), [bills, type, provider, from, to]);
  const selectedFee = trends.feeTypes.find(fee => fee.key === feeId);
  const feeLabel = selectedFee?.label ?? 'Total fees';
  const feeValue = (month: typeof trends.months[number]) => selectedFee ? month.fees[selectedFee.id] : month.feeTotal;

  return (
    <div className="space-y-6">
      <Panel title="Usage, cost & fee trends" description="Monthly totals by bill date (service period end when captured). Multiple bills in a month are added together; months without bills are gaps.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Utility type"><select aria-label="Trend utility type" className={SELECT} value={type} onChange={event => { setType(event.target.value as UtilityType); setProvider(''); setFeeId('total'); }}>
            <option value="electric">Electric</option><option value="gas">Gas</option><option value="water">Water</option>
          </select></Field>
          <Field label="Provider"><select aria-label="Trend provider" className={SELECT} value={provider} onChange={event => { setProvider(event.target.value); setFeeId('total'); }}>
            <option value="">All providers</option>{providers.filter(Boolean).map(name => <option key={name} value={name}>{name}</option>)}
          </select></Field>
          <Field label="From"><input aria-label="Trend start date" type="date" className={INPUT} value={from} onChange={event => setFrom(event.target.value)} /></Field>
          <Field label="Through"><input aria-label="Trend end date" type="date" className={INPUT} value={to} onChange={event => setTo(event.target.value)} /></Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-secondary">
          <p>{trends.billCount} bill{trends.billCount === 1 ? '' : 's'} in this selection{dirty ? ' · Includes unsaved changes' : ''}</p>
          <button type="button" className="min-h-11 text-primary hover:text-primary-hover" onClick={() => { setFrom(''); setTo(''); }}>Show all dates</button>
        </div>
        {from && to && from > to && <p className="text-sm text-error" role="alert">Choose an end date on or after the start date.</p>}
      </Panel>
      {trends.billCount === 0 ? <Empty>No bills match these filters. Import bills on Usage & rates, or change the filters.</Empty> : <>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Panel title="Cost over time" description="Total utility cost, including supply, fees and taxes. Non-utility items are excluded.">
            <TrendChart data={trends.months.map(month => ({ month: month.month, value: month.cost }))} label="Utility cost" money />
          </Panel>
          {trends.units.map(unit => <Panel key={unit} title={`Usage over time · ${unitLabels[unit]}`} description="Consumption is plotted in its recorded units; different units are never added together.">
            <TrendChart data={trends.months.map(month => ({ month: month.month, value: month.usage[unit] ?? null }))} label={`Usage (${unitLabels[unit]})`} />
          </Panel>)}
        </div>
        <Panel title="Fees over time" description="Compare each named fee across the selected months. Values are monthly charges, not tariff rates; bill count and consumption can affect them.">
          {trends.missingBreakdowns > 0 && <p className="mb-4 text-sm text-foreground-secondary">{trends.missingBreakdowns} bill{trends.missingBreakdowns === 1 ? ' has' : 's have'} no fee breakdown. Affected months have gaps rather than assumed zero fees.</p>}
          {trends.months.every(month => month.feeTotal === null) ? <Empty>No complete monthly fee breakdowns in this selection.</Empty> : <>
            <Field label="Fee type"><select aria-label="Fee type" className={`${SELECT} sm:max-w-md`} value={selectedFee?.key ?? 'total'} onChange={event => setFeeId(event.target.value)}>
              <option value="total">Total fees</option>{trends.feeTypes.map(fee => <option key={fee.id} value={fee.key}>{fee.label}</option>)}
            </select></Field>
            <TrendChart data={trends.months.map(month => ({ month: month.month, value: feeValue(month) }))} label={feeLabel} money />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="mb-3 text-left text-xs text-foreground-secondary">First and latest months with known amounts in this selection. A percentage is unavailable when the starting amount is zero.</caption>
                <thead><tr className="border-b border-border text-foreground-secondary"><th className="p-2 text-left">Fee type</th><th className="p-2 text-right">First month</th><th className="p-2 text-right">Latest month</th><th className="p-2 text-right">Change</th><th className="p-2 text-right">Change (%)</th></tr></thead>
                <tbody>{trends.comparisons.map(fee => <tr key={fee.id} className="border-b border-border">
                  <th className="p-2 text-left font-normal"><button type="button" className="min-h-11 text-left text-primary hover:underline" onClick={() => setFeeId(fee.key)}>{fee.label}</button></th>
                  <td className="p-2 text-right font-mono">{fee.first === null ? '—' : <>{formatCurrency(fee.first)}<span className="block text-xs text-foreground-muted">{monthLabel(fee.firstMonth!)}</span></>}</td>
                  <td className="p-2 text-right font-mono">{fee.latest === null ? '—' : <>{formatCurrency(fee.latest)}<span className="block text-xs text-foreground-muted">{monthLabel(fee.latestMonth!)}</span></>}</td>
                  <td className="p-2 text-right font-mono">{change(fee.delta)}</td><td className="p-2 text-right font-mono">{fee.percent === null ? '—' : `${fee.percent > 0 ? '+' : ''}${numeric(fee.percent)}%`}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </>}
        </Panel>
        <Panel title="Monthly values" description="The figures behind the charts. A dash means no recorded amount, not zero.">
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="border-b border-border text-foreground-secondary"><th className="p-2 text-left">Month</th><th className="p-2 text-right">Bills</th><th className="p-2 text-right">Cost</th>{trends.units.map(unit => <th key={unit} className="p-2 text-right">Usage ({unitLabels[unit]})</th>)}<th className="p-2 text-right">{feeLabel}</th></tr></thead>
            <tbody>{trends.months.map(month => <tr key={month.month} className="border-b border-border font-mono">
              <th className="p-2 text-left font-normal">{monthLabel(month.month)}</th><td className="p-2 text-right">{month.billCount}</td><td className="p-2 text-right">{month.cost === null ? '—' : formatCurrency(month.cost)}</td>
              {trends.units.map(unit => <td key={unit} className="p-2 text-right">{month.usage[unit] === undefined ? '—' : numeric(month.usage[unit]!)}</td>)}
              <td className="p-2 text-right">{feeValue(month) == null ? '—' : formatCurrency(feeValue(month)!)}</td>
            </tr>)}</tbody>
          </table></div>
        </Panel>
      </>}
    </div>
  );
}
