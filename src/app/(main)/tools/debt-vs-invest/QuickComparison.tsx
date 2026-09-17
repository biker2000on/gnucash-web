'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useBooks } from '@/contexts/BookContext';
import { FieldGrid, INPUT, SELECT, LABEL, TNUM } from '@/components/ui/form';
import { ProvenanceModal } from '@/components/provenance/ProvenanceModal';
import type { CalculationTrace } from '@/lib/financial-actions/types';
import { compareDebtInvestment, INPUT_LIMITS, STRATEGIES, validateDebtInvestmentInputs, type DebtInvestmentInputs, type DebtInvestmentStrategy } from '@/lib/debt-vs-invest';
import { monthToLabel } from '../debt-payoff/DebtPayoffChart';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const names = { payoff: 'Pay off debt', invest: 'Invest', split: 'Split' };
const colors = { payoff: 'var(--primary)', invest: 'var(--secondary)', split: 'var(--foreground-secondary)' };
const labels: Record<keyof DebtInvestmentInputs, string> = {
  balance: 'Current debt balance ($)', debtRate: 'Fixed annual debt rate (%)', monthlyPayment: 'Scheduled monthly principal + interest ($)',
  lumpSum: 'Available lump sum today ($)', extraMonthly: 'Extra available each month ($)',
  annualReturn: 'Effective annual investment return (%)', years: 'Comparison period (years)', splitPercent: 'Split strategy: share toward debt (%)',
};
const defaults: DebtInvestmentInputs = { balance: 250000, debtRate: 5, monthlyPayment: 1500, lumpSum: 25000, extraMonthly: 500, annualReturn: 7, years: 20, splitPercent: 50 };
type DebtOption = { guid: string; name: string; currency: string; balance: number; apr: number; minPayment: number; source: string };
const assumptions = [
  'One fixed-rate debt; interest accrues monthly at the annual debt rate divided by 12. No further borrowing or payment recast.',
  'The lump sum is allocated today. Each month investments grow first, then payments and contributions occur at month end.',
  'Every strategy uses the scheduled payment plus extra monthly cash as its budget, even after debt payoff. Unused payments and excess lump sums are invested.',
  'Returns are effective annual, nominal, constant, and before tax and fees. Investments are assumed accessible with no withdrawal restrictions.',
  'The comparison includes investments minus debt only; unchanged home value, existing assets, and emergency reserves are excluded.',
];
const warnings = ['Market returns are uncertain. No taxes, deductions, investment fees, mortgage insurance, prepayment penalties, or withdrawal taxes/penalties are modeled.'];

export function ComparisonChart({ data, sensitivity = false }: { data: Record<string, number>[]; sensitivity?: boolean }) {
  return <div className="h-72 w-full" role="img" aria-label={sensitivity ? 'Return sensitivity: advantage over investing, with exact values in the table below' : 'Projected investments minus remaining debt for each strategy, with yearly values in the table below'}>
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 12, right: 16, bottom: 12, left: 12 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey={sensitivity ? 'rate' : 'year'} type="number" domain={['dataMin', 'dataMax']} tick={{ fill: 'var(--foreground-secondary)', fontSize: 12 }} tickFormatter={n => sensitivity ? `${Number(n.toFixed(1))}%` : `${n} yr`} />
        <YAxis width={80} tick={{ fill: 'var(--foreground-secondary)', fontSize: 12, fontFamily: 'var(--font-geist-mono), monospace' }} tickFormatter={n => money.format(n)} />
        <Tooltip formatter={value => money.format(Number(value))} labelFormatter={value => sensitivity ? `${value}% annual return` : `Year ${value}`} contentStyle={{ background: 'var(--surface-elevated)', borderColor: 'var(--border)', borderRadius: 6, fontFamily: 'var(--font-geist-mono), monospace' }} />
        <Legend />
        <ReferenceLine y={0} stroke="var(--border-hover)" />
        {STRATEGIES.filter(s => !sensitivity || s !== 'invest').map(s => <Line key={s} dataKey={s} name={names[s]} stroke={colors[s]} strokeWidth={2} strokeDasharray={s === 'split' ? '5 4' : undefined} dot={false} isAnimationActive={false} />)}
      </LineChart>
    </ResponsiveContainer>
  </div>;
}

export default function QuickComparison() {
  const { activeBookGuid } = useBooks();
  return <DebtComparison key={activeBookGuid ?? 'manual'} bookGuid={activeBookGuid} />;
}

function DebtComparison({ bookGuid }: { bookGuid: string | null }) {
  const [fields, setFields] = useState(() => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, String(value)])) as Record<keyof DebtInvestmentInputs, string>);
  const [debts, setDebts] = useState<DebtOption[]>([]);
  const [importStatus, setImportStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [imported, setImported] = useState<DebtOption | null>(null);
  const [trace, setTrace] = useState<CalculationTrace | null>(null);
  const input = useMemo(() => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim() === '' ? NaN : Number(value)])) as unknown as DebtInvestmentInputs, [fields]);
  const invalidFields = (Object.keys(labels) as (keyof DebtInvestmentInputs)[]).filter(key => !Number.isFinite(input[key]) || input[key] < INPUT_LIMITS[key][0] || input[key] > INPUT_LIMITS[key][1] || (key === 'years' && !Number.isInteger(input[key])));
  const error = invalidFields.length ? 'Complete the highlighted fields within the allowed ranges.' : validateDebtInvestmentInputs(input);
  const result = useMemo(() => error ? null : compareDebtInvestment(input), [input, error]);
  const chartData = result?.plans.invest.points.filter(p => p.month % 12 === 0).map(p => ({ year: p.month / 12, ...Object.fromEntries(STRATEGIES.map(s => [s, result.plans[s].points[p.month].netWorth])) })) ?? [];

  async function loadDebts() {
    setLoading(true);
    setImportStatus('');
    try {
      const response = await fetch('/api/tools/debt-payoff');
      if (!response.ok) throw new Error('Could not load debts. You can still enter the figures manually.');
      const data = await response.json();
      const available = (data.debts as DebtOption[]).filter(d => d.currency === 'USD' && d.balance > 0);
      setDebts(available);
      setImportStatus(available.length ? 'Choose a debt below. Review the imported rate and principal-and-interest payment before comparing.' : 'No outstanding US-dollar debts found in this book. Enter your debt manually.');
    } catch (e) {
      setImportStatus(e instanceof Error ? e.message : 'Could not load debts. Enter your debt manually.');
    } finally { setLoading(false); }
  }

  function importDebt(guid: string) {
    const debt = debts.find(d => d.guid === guid);
    if (!debt) return;
    setImported(debt);
    setFields(old => ({ ...old, balance: String(debt.balance), debtRate: debt.source === 'default' ? '' : String(debt.apr), monthlyPayment: debt.minPayment > 0 ? String(debt.minPayment) : '' }));
  }

  function explain(strategy: DebtInvestmentStrategy) {
    if (!result) return;
    const plan = result.plans[strategy];
    const now = new Date().toISOString();
    setTrace({
      id: `debt-vs-invest:${strategy}:${JSON.stringify(input)}`, version: 1, title: `${names[strategy]}: projected comparison value`,
      summary: `Investments minus debt after ${input.years} years. This is a scenario, not your total household net worth.`,
      generatedAt: now, asOfDate: now.slice(0, 10), result: plan.final.netWorth, unit: 'currency',
      formula: 'Comparison value = projected investments − remaining debt', assumptions, warnings,
      evidence: [{ kind: 'assumption', id: 'inputs', label: 'Current editable scenario inputs', source: 'manual', metadata: { ...input, bookGuid } }, ...(imported ? [{ kind: 'account' as const, id: imported.guid, label: `${imported.name}: initial import (inputs may have been edited)`, source: 'system' as const, href: `/accounts/${imported.guid}`, metadata: { balance: imported.balance, rate: imported.apr, payment: imported.minPayment, source: imported.source } }] : [])],
      steps: [
        { key: 'budget', label: 'Equal monthly budget', inputs: { scheduledPayment: input.monthlyPayment, extra: input.extraMonthly }, result: input.monthlyPayment + input.extraMonthly },
        { key: 'allocation', label: 'Share of available cash allocated to debt', inputs: { strategy }, result: strategy === 'payoff' ? '100%' : strategy === 'invest' ? '0%' : `${input.splitPercent}%` },
        ...plan.points.filter(p => p.month === 0 || p.month % 12 === 0).map(p => ({ key: `month-${p.month}`, label: `Year ${p.month / 12}`, formula: 'investments − debt', inputs: { investments: p.investments, remainingDebt: p.debt, cumulativeInterest: p.interest }, result: p.netWorth })),
      ],
    });
  }

  return <div className="max-w-[1400px] mx-auto space-y-6">
    <header>
      <h1 className="text-3xl font-bold text-foreground">Pay Off Debt or Invest?</h1>
      <p className="text-sm text-foreground-secondary mt-2">Compare a lump sum and extra monthly cash across three strategies using the same budget and end date.</p>
      <p className="text-xs text-foreground-muted mt-1">Illustrative defaults · US dollars · before tax · changes are not saved</p>
    </header>

    <section className="bg-surface border border-border rounded-lg p-4 sm:p-6 space-y-4" aria-labelledby="assumptions-heading">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <h2 id="assumptions-heading" className="text-lg font-semibold">Assumptions</h2>
        <button type="button" disabled={loading || !bookGuid} onClick={loadDebts} className="rounded-md border border-border px-3 py-2 text-sm text-primary hover:bg-surface-hover disabled:opacity-50">{loading ? 'Loading debts…' : 'Import mortgage or debt'}</button>
      </div>
      {importStatus && <p role="status" className="text-sm text-foreground-secondary">{importStatus}</p>}
      {debts.length > 0 && <label className="block"><span className={LABEL}>Debt in the active book</span><select className={SELECT} value={imported?.guid ?? ''} onChange={e => importDebt(e.target.value)}><option value="" disabled>Choose a debt</option>{debts.map(d => <option key={d.guid} value={d.guid}>{d.name}{d.source === 'mortgage' ? ' — saved mortgage terms' : ''}</option>)}</select></label>}
      {imported && <p className="text-xs text-foreground-secondary">Started from {imported.name}. Values below remain editable. Imports use current balances and saved linked mortgage or debt-planner terms.</p>}
      <FieldGrid>
        {(Object.keys(labels) as (keyof DebtInvestmentInputs)[]).map(key => <div key={key}>
          <label htmlFor={`comparison-${key}`} className={LABEL}>{labels[key]}</label>
          <input id={`comparison-${key}`} type="number" className={`${INPUT} font-mono ${invalidFields.includes(key) ? 'border-error' : ''}`} value={fields[key]} min={INPUT_LIMITS[key][0]} max={INPUT_LIMITS[key][1]} step={key === 'years' ? 1 : 'any'} aria-invalid={invalidFields.includes(key)} aria-describedby={invalidFields.includes(key) ? `${key}-error` : undefined} onChange={e => setFields(old => ({ ...old, [key]: e.target.value }))} />
          {invalidFields.includes(key) && <span id={`${key}-error`} className="block text-xs text-error mt-1">Enter {key === 'years' ? 'a whole number' : 'a number'} from {INPUT_LIMITS[key][0]} to {INPUT_LIMITS[key][1]}.</span>}
        </div>)}
      </FieldGrid>
      <p className="text-xs text-foreground-secondary">Exclude property taxes, homeowners insurance, and mortgage insurance from the scheduled payment. Keep emergency reserves outside the available lump sum. Extra principal shortens repayment; it does not recast the scheduled payment.</p>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
    </section>

    {result && <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {STRATEGIES.map(strategy => {
          const plan = result.plans[strategy];
          const difference = plan.final.netWorth - result.plans.invest.final.netWorth;
          return <section key={strategy} className="bg-surface border border-border rounded-lg p-4 space-y-3">
            <h2 className="font-semibold text-lg">{names[strategy]}</h2>
            <p className="min-h-10 text-xs text-foreground-secondary">{strategy === 'payoff' ? 'Available cash pays debt first; freed payments are invested.' : strategy === 'invest' ? 'Make scheduled payments and invest all available cash.' : `${input.splitPercent}% of available cash pays debt; the rest is invested.`}</p>
            <div><p className="text-xs text-foreground-secondary">Investments minus debt at year {input.years}</p><p className={`font-mono text-2xl ${plan.final.netWorth < 0 ? 'text-negative' : 'text-foreground'}`} style={TNUM}>{money.format(plan.final.netWorth)}</p></div>
            <dl className="text-sm space-y-2">
              {[
                ['Difference vs investing', money.format(difference)],
                ['Accessible investments', money.format(plan.final.investments)],
                ['Remaining debt', money.format(plan.final.debt)],
                ['Interest paid in period', money.format(plan.final.interest)],
                ['Interest saved vs investing', money.format(result.plans.invest.final.interest - plan.final.interest)],
                ['Debt-free', plan.payoffMonth === null ? 'Beyond comparison period' : plan.payoffMonth === 0 ? 'Today' : `${monthToLabel(plan.payoffMonth)} (${plan.payoffMonth} months)`],
              ].map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className="text-foreground-secondary">{label}</dt><dd className={`font-mono text-right ${label === 'Difference vs investing' && difference !== 0 ? difference < 0 ? 'text-negative' : 'text-positive' : ''}`} style={TNUM}>{value}</dd></div>)}
            </dl>
            <button type="button" className="text-primary text-sm hover:underline" onClick={() => explain(strategy)}>Explain this number<span className="sr-only"> for {names[strategy]}</span></button>
          </section>;
        })}
      </div>
      <section className="bg-surface border border-border rounded-lg p-4 sm:p-6 space-y-4">
        <h2 className="text-lg font-semibold">Projected investments minus debt</h2>
        <p className="text-sm text-foreground-secondary">This compares the part of net worth affected by the decision. Home value and other unchanged assets are excluded. Debt reduction is not accessible cash.</p>
        <ComparisonChart data={chartData} />
        <details><summary className="cursor-pointer text-sm text-primary">Yearly values</summary><div className="overflow-x-auto mt-3"><table className="w-full text-sm"><caption className="sr-only">Investments minus remaining debt by year</caption><thead><tr><th scope="col" className="text-left p-2">Year</th>{STRATEGIES.map(s => <th scope="col" key={s} className="text-right p-2">{names[s]}</th>)}</tr></thead><tbody>{chartData.map(p => <tr key={p.year} className="border-t border-border"><th scope="row" className="text-left p-2 font-mono">{p.year}</th>{STRATEGIES.map(s => <td key={s} className="text-right p-2 font-mono">{money.format(p[s as keyof typeof p])}</td>)}</tr>)}</tbody></table></div></details>
      </section>
      <section className="bg-surface border border-border rounded-lg p-4 sm:p-6 space-y-4">
        <h2 className="text-lg font-semibold">How much does the investment return matter?</h2>
        <p className="text-sm text-foreground-secondary">{result.breakEvenReturn === null ? 'No break-even rate: these inputs leave no allocation decision, so the strategies are identical.' : `Break-even investment return: ${result.breakEvenReturn.toFixed(2)}% effective annually. Below this rate, paying debt first finishes ahead; above it, investing finishes ahead in this constant-return model.`}</p>
        <p className="text-xs text-foreground-secondary">The break-even rate compounds the debt’s monthly rate over a year. It does not price market risk. Positive chart values mean an advantage over investing.</p>
        <ComparisonChart data={result.sensitivity} sensitivity />
        <details><summary className="cursor-pointer text-sm text-primary">Return sensitivity values</summary><div className="overflow-x-auto mt-3"><table className="w-full text-sm"><caption className="sr-only">Advantage over investing at each effective annual return</caption><thead><tr><th scope="col" className="text-right p-2">Annual return</th><th scope="col" className="text-right p-2">Pay off debt</th><th scope="col" className="text-right p-2">Split</th></tr></thead><tbody>{result.sensitivity.map(p => <tr key={p.rate} className="border-t border-border">{[`${p.rate.toFixed(2)}%`, money.format(p.payoff), money.format(p.split)].map((v, i) => <td key={i} className="text-right p-2 font-mono">{v}</td>)}</tr>)}</tbody></table></div></details>
      </section>
    </>}
    <section className="bg-surface border border-border rounded-lg p-4 sm:p-6 space-y-4">
      <h2 className="text-lg font-semibold">Beyond the projected return</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-foreground-secondary">
        <div><h3 className="font-semibold text-foreground mb-2">Pay off debt</h3><p>Reduces interest and eventually removes a required payment. Being debt-free may offer peace of mind. Money paid into a mortgage becomes home equity; accessing it again may require selling or borrowing.</p></div>
        <div><h3 className="font-semibold text-foreground mb-2">Invest</h3><p>Keeps money in investments that may be easier to access and may grow faster than debt costs. Returns can fall short or be negative, and scheduled debt payments continue. Retirement accounts may restrict withdrawals.</p></div>
        <div><h3 className="font-semibold text-foreground mb-2">Split</h3><p>Makes progress on both goals and preserves some invested funds. It pays debt more slowly than dedicating all extra cash to payoff and retains investment risk. The right balance also depends on your cash reserves and comfort with debt.</p></div>
      </div>
      <details><summary className="cursor-pointer text-sm text-primary">Calculation assumptions and limits</summary><ul className="list-disc pl-5 text-sm text-foreground-secondary mt-3 space-y-2">{[...assumptions, ...warnings].map(a => <li key={a}>{a}</li>)}</ul></details>
      <div className="flex flex-wrap gap-4 text-sm text-primary"><Link href="/tools/mortgage">Mortgage calculator</Link><Link href="/tools/debt-payoff">Debt payoff planner</Link><Link href="/tools/fire-calculator">Financial independence calculator</Link></div>
    </section>
    <ProvenanceModal trace={trace} isOpen={trace !== null} onClose={() => setTrace(null)} />
  </div>;
}
