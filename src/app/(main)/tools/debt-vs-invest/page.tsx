'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useBooks } from '@/contexts/BookContext';
import { FieldGrid, INPUT, SELECT, LABEL } from '@/components/ui/form';
import { ProvenanceModal } from '@/components/provenance/ProvenanceModal';
import type { CalculationTrace } from '@/lib/financial-actions/types';
import { STRATEGIES, type DebtInvestmentStrategy } from '@/lib/debt-vs-invest';
import { comparePlanner, defaultPlanner, newPlannerDebt, PLANNER_ASSUMPTIONS, PlannerSchema, projectPlanner, STRATEGY_NAMES, type PlannerDebt, type PlannerScenario, type simulatePlanner } from '@/lib/debt-investment-planner';
import QuickComparison, { ComparisonChart } from './QuickComparison';
import { monthToLabel } from '../debt-payoff/DebtPayoffChart';
import { SimulationResults } from './SimulationResults';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const panel = 'bg-surface border border-border rounded-lg p-4 sm:p-6 space-y-4';
const button = 'rounded-md border border-border px-3 py-2 text-sm text-primary hover:bg-surface-hover disabled:opacity-50';
type Saved = { id: number; name: string; config: unknown };
type ImportedDebt = { guid: string; name: string; currency: string; balance: number; apr: number; minPayment: number; source: string };
type SimResult = ReturnType<typeof simulatePlanner>;
type NumericKey = { [K in keyof PlannerScenario]: PlannerScenario[K] extends number ? K : never }[keyof PlannerScenario];

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const id = useId();
  return <div><label htmlFor={id} className={LABEL}>{label}</label><input id={id} className={`${INPUT} font-mono`} type="number" step="any" value={Number.isFinite(value) ? value : ''} aria-invalid={!Number.isFinite(value)} onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} /></div>;
}
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  const id = useId();
  return <div><label className={LABEL} htmlFor={id}>{label}</label><select id={id} className={SELECT} value={value} onChange={e => onChange(e.target.value)}>{options.map(([v, name]) => <option key={v} value={v}>{name}</option>)}</select></div>;
}
export default function DebtVsInvestPage() {
  const { activeBookGuid } = useBooks();
  const [quick, setQuick] = useState(false);
  return <><div className="flex gap-3 mb-4"><button className={button} aria-pressed={!quick} onClick={() => setQuick(false)}>Full planner</button><button className={button} aria-pressed={quick} onClick={() => setQuick(true)}>Quick fixed-rate comparison</button></div>{quick ? <QuickComparison /> : <Planner key={activeBookGuid ?? 'manual'} bookGuid={activeBookGuid} />}</>;
}
function Planner({ bookGuid }: { bookGuid: string | null }) {
  const [draft, setDraft] = useState(defaultPlanner);
  const [applied, setApplied] = useState(defaultPlanner);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [name, setName] = useState('Debt strategy');
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [comparedIds, setComparedIds] = useState<number[]>([]);
  const [imports, setImports] = useState<ImportedDebt[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [simulation, setSimulation] = useState<SimResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [trace, setTrace] = useState<CalculationTrace | null>(null);
  const worker = useRef<Worker | null>(null);
  const result = useMemo(() => comparePlanner(applied), [applied]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const shortfall = STRATEGIES.some(k => result.plans[k].final.shortfall > 0);
  const chartData = result.plans.invest.points.filter(p => p.month % 12 === 0).map(p => ({ year: p.month / 12, ...Object.fromEntries(STRATEGIES.map(k => [k, result.plans[k].points[p.month].netWorth])) })) as Record<string, number>[];
  const comparisons = useMemo(() => saved.filter(row => comparedIds.includes(row.id)).flatMap(row => {
    const parsed = PlannerSchema.safeParse(row.config);
    return parsed.success ? [{ row, scenario: parsed.data, values: STRATEGIES.map(k => projectPlanner(parsed.data, k)) }] : [];
  }), [saved, comparedIds]);
  useEffect(() => {
    if (!bookGuid) return;
    const abort = new AbortController();
    fetch('/api/tools/config?toolType=debt-vs-invest', { signal: abort.signal }).then(async r => {
      if (!r.ok) throw new Error('Could not load saved scenarios.');
      const rows: Saved[] = await r.json();
      setSaved(rows);
      const requested = Number(new URLSearchParams(window.location.search).get('scenario'));
      const row = rows.find(item => item.id === requested);
      if (row) {
        const parsed = PlannerSchema.safeParse(row.config);
        if (parsed.success) { setDraft(parsed.data); setApplied(parsed.data); setName(row.name); setLoadedId(row.id); }
      }
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [bookGuid]);
  useEffect(() => () => worker.current?.terminate(), []);
  function update<K extends keyof PlannerScenario>(key: K, value: PlannerScenario[K]) { setDraft(old => ({ ...old, [key]: value })); }
  function updateDebt(index: number, patch: Partial<PlannerDebt>) { setDraft(old => ({ ...old, debts: old.debts.map((d, i) => i === index ? { ...d, ...patch } : d) })); }
  function apply(value: unknown = draft): PlannerScenario | null {
    const parsed = PlannerSchema.safeParse(value);
    if (!parsed.success) { setError(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' ')); return null; }
    worker.current?.terminate(); setSimulating(false); setSimulation(null); setDraft(parsed.data); setApplied(parsed.data); setError('');
    return parsed.data;
  }
  async function request(url: string, method = 'GET', body?: unknown) {
    const response = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    if (response.status === 204) return null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Request failed.');
    return data;
  }
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setBusy(false); } }
  async function save(overwrite: boolean) {
    const scenario = apply(); if (!scenario || !name.trim()) { if (!name.trim()) setError('Enter a scenario name.'); return; }
    await run(async () => {
      const row = await request(overwrite ? `/api/tools/config/${loadedId}` : '/api/tools/config', overwrite ? 'PUT' : 'POST', { name: name.trim(), toolType: 'debt-vs-invest', config: scenario });
      setSaved(old => [row, ...old.filter(r => r.id !== row.id)]); setLoadedId(row.id);
      setMessage('Scenario saved in this book. Review it in the Action Center after refreshing actions.');
    });
  }
  function load(row: Saved) { const scenario = apply(row.config); if (scenario) { setDraft(scenario); setName(row.name); setLoadedId(row.id); setMessage(`Loaded ${row.name}.`); } }
  function simulate() {
    const scenario = apply(); if (!scenario) return;
    setSimulating(true);
    const current = new Worker(new URL('./simulation.worker.ts', import.meta.url)); worker.current = current;
    current.onmessage = e => { setSimulating(false); if (e.data.error) setError(e.data.error); else setSimulation(e.data.result); current.terminate(); };
    current.onerror = () => { setError('Simulation could not run. Try fewer runs or a shorter horizon.'); setSimulating(false); current.terminate(); };
    current.postMessage(scenario);
  }
  function explain(strategy: DebtInvestmentStrategy) {
    const p = result.plans[strategy]; const now = new Date().toISOString();
    setTrace({ id: `debt-investment-${strategy}-${now}`, version: 2, title: `${STRATEGY_NAMES[strategy]}: after-tax comparison`, summary: 'Hypothetical after-tax investment liquidation plus protected cash minus remaining debt.', generatedAt: now, asOfDate: now.slice(0, 10), result: p.final.netWorth, unit: 'currency', formula: 'after-tax investments + reserve − debt', assumptions: PLANNER_ASSUMPTIONS, warnings: ['Constant-return result; market outcomes and tax rules can differ.', ...(p.final.shortfall > 0 ? ['This strategy has an unfunded payment or fee; do not treat it as a feasible plan.'] : [])], evidence: [{ kind: 'assumption', id: 'scenario', source: 'manual', label: 'Applied scenario inputs', metadata: { ...applied, bookGuid } }], steps: p.points.filter(point => point.month % 12 === 0).map(point => ({ key: String(point.month), label: `Year ${point.month / 12}`, inputs: { investments: point.investments, afterTaxInvestments: point.afterTaxInvestments, debt: point.debt, reserve: applied.reserve, interest: point.interest, taxBenefit: point.taxBenefit, taxesPaid: point.taxes, fees: point.fees, insurance: point.insurance, unfundedPayments: point.shortfall }, result: point.netWorth })) });
  }
  const numeric = (key: NumericKey, label: string) => <NumberField key={key} label={label} value={draft[key]} onChange={v => update(key, v)} />;

  return <div className="max-w-[1400px] mx-auto space-y-6">
    <header><h1 className="text-3xl font-bold">Pay Off Debt or Invest?</h1><p className="text-sm text-foreground-secondary mt-2">Equal-budget strategies with multiple debts, taxes, lender rules, and market uncertainty.</p><p className="text-xs text-foreground-muted mt-1">US dollars · illustrative starting values · save scenarios explicitly</p></header>
    {error && <p role="alert" className="rounded-md border border-error p-3 text-sm text-error">{error}</p>}{message && <p role="status" className="text-sm text-foreground-secondary">{message}</p>}
    <section className={panel}><h2 className="text-lg font-semibold">Saved scenarios</h2>
      <div className="flex flex-wrap gap-3 items-end"><label className="flex-1 min-w-48"><span className={LABEL}>Scenario name</span><input className={INPUT} value={name} maxLength={255} onChange={e => setName(e.target.value)} /></label><button className={button} disabled={busy || !bookGuid} onClick={() => save(false)}>Save as new</button><button className={button} disabled={busy || loadedId === null} onClick={() => save(true)}>Update loaded scenario</button></div>
      <p className="text-xs text-foreground-secondary">Select up to three scenarios to compare. Loading, switching modes, or changing books replaces unsaved inputs.</p>
      {saved.map(row => <div key={row.id} className="flex flex-wrap items-center gap-3 border-t border-border pt-3"><label className="flex-1 text-sm"><input type="checkbox" className="mr-2" checked={comparedIds.includes(row.id)} disabled={!comparedIds.includes(row.id) && comparedIds.length >= 3} onChange={e => setComparedIds(old => e.target.checked ? [...old, row.id] : old.filter(id => id !== row.id))} />{row.name}</label><button className={button} onClick={() => load(row)}>Load<span className="sr-only"> {row.name}</span></button><button className={button} disabled={busy} onClick={() => run(async () => { await request(`/api/tools/config/${row.id}`, 'DELETE'); setSaved(old => old.filter(r => r.id !== row.id)); setComparedIds(old => old.filter(id => id !== row.id)); if (loadedId === row.id) setLoadedId(null); })}>Delete<span className="sr-only"> {row.name}</span></button></div>)}
      {comparisons.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm"><caption className="text-left text-foreground-secondary py-2">Saved inputs recalculated today. Compare like horizons and budgets.</caption><thead><tr>{['Scenario', 'Years', 'Lump sum', 'Monthly budget', ...STRATEGIES.map(k => STRATEGY_NAMES[k])].map(h => <th key={h} className="text-right p-2">{h}</th>)}</tr></thead><tbody>{comparisons.map(({ row, scenario, values }) => <tr key={row.id} className="border-t border-border"><th scope="row" className="text-left p-2">{row.name}</th>{[scenario.years, money.format(scenario.lumpSum), money.format(scenario.extraMonthly + scenario.debts.reduce((sum, d) => sum + d.payment + d.insurance, 0)), ...values.map(p => p.final.shortfall > 0 ? 'Unfunded payments' : money.format(p.final.netWorth))].map((v, i) => <td key={i} className="text-right p-2 font-mono">{v}</td>)}</tr>)}</tbody></table></div>}
    </section>
    <section className={panel}><div className="flex flex-wrap gap-3 justify-between items-center"><h2 className="text-lg font-semibold">Debts and lender rules</h2><div className="flex flex-wrap gap-2"><button className={button} disabled={draft.debts.length >= 12} onClick={() => update('debts', [...draft.debts, { ...newPlannerDebt(crypto.randomUUID()), name: 'New debt', balance: 10000, payment: 250 }])}>Add debt</button><button className={button} disabled={busy || !bookGuid} onClick={() => run(async () => { const data = await request('/api/tools/debt-payoff'); setImports(data.debts.filter((d: ImportedDebt) => d.currency === 'USD' && d.balance > 0)); setMessage('Choose debts to add. Review imported terms; only outstanding US-dollar debts are shown.'); })}>Import mortgage or debt</button></div></div>
      {imports.length > 0 && <SelectField label="Add a debt from this book" value="" options={[[ '', 'Choose a debt'], ...imports.filter(d => !draft.debts.some(row => row.id === d.guid)).map(d => [d.guid, d.name] as [string, string])]} onChange={guid => { const d = imports.find(row => row.guid === guid); if (!d || draft.debts.length >= 12) return; update('debts', [...draft.debts, { ...newPlannerDebt(d.guid), name: d.name, balance: d.balance, rate: d.source === 'default' ? NaN : d.apr, payment: d.minPayment > 0 ? d.minPayment : NaN }]); }} />}
      <SelectField label="Extra-payment priority" value={draft.priority} onChange={v => update('priority', v as PlannerScenario['priority'])} options={[[ 'avalanche', 'Highest rate first'], ['snowball', 'Smallest balance first'], ['listed', 'Listed order']]} />
      {draft.debts.map((d, index) => <DebtEditor key={d.id} debt={d} onChange={patch => updateDebt(index, patch)} onRemove={draft.debts.length === 1 ? undefined : () => update('debts', draft.debts.filter((_, i) => i !== index))} onMove={index === 0 ? undefined : () => { const rows = [...draft.debts]; [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]]; update('debts', rows); }} />)}
    </section>
    <section className={panel}><h2 className="text-lg font-semibold">Available funds and comparison</h2><FieldGrid>{numeric('lumpSum', 'Lump sum ($)')}{numeric('extraMonthly', 'Extra monthly cash ($)')}{numeric('reserve', 'Protect this much of the lump sum as cash ($)')}{numeric('existingInvestments', 'Other existing investments ($)')}{numeric('annualReturn', 'Effective annual total return (%)')}{numeric('years', 'Comparison years')}{numeric('splitPercent', 'Split strategy: share toward debt (%)')}</FieldGrid><p className="text-xs text-foreground-secondary">Protected cash earns zero return. Other investments grow but do not fund extra debt payments.</p></section>
    <section className={panel}><details><summary className="text-lg font-semibold cursor-pointer">Taxes, investment fees, and withdrawals</summary><div className="space-y-4 mt-4"><SelectField label="Investment tax treatment" value={draft.accountType} onChange={v => update('accountType', v as PlannerScenario['accountType'])} options={[[ 'taxable', 'Taxable investments'], ['deferred', 'Tax-deferred retirement account'], ['taxFree', 'Qualified tax-free withdrawals']]} />
      <label className="block text-sm"><input type="checkbox" className="mr-2" checked={draft.lumpAlreadyInvested} onChange={e => update('lumpAlreadyInvested', e.target.checked)} />Lump sum is already invested (payoff withdrawals may incur tax)</label><FieldGrid>{([
        ['lumpGainPercent', 'Unrealized gain share of invested lump sum (%)'], ['existingBasisPercent', 'After-tax basis share of other investments (%)'], ['capitalGainsTax', 'Capital gains tax rate (%)'], ['withdrawalTax', 'Retirement withdrawal tax rate (%)'], ['earlyPenalty', 'Applicable early withdrawal penalty (%)'], ['accessAge', 'Age early penalty stops applying'], ['feePercent', 'Annual investment fees (%)'], ['dividendYield', 'Dividend yield included in total return (%)'], ['dividendTax', 'Dividend tax rate (%)'], ['marginalTax', 'Marginal income tax rate (%)'], ['standardDeduction', 'Annual standard deduction ($)'], ['otherItemized', 'Other annual itemized deductions ($)'],
      ] as [NumericKey, string][]).map(([key, label]) => numeric(key, label))}</FieldGrid><label className="block text-sm"><input type="checkbox" className="mr-2" checked={draft.deductibleContributions} onChange={e => update('deductibleContributions', e.target.checked)} />New tax-deferred contributions are deductible; reinvest the tax relief at the marginal rate</label>
      <p className="text-xs text-foreground-secondary">Tax rates start at zero. Set pre-tax retirement assets’ basis to zero. Non-deductible contributions add after-tax basis. Contribution limits, withdrawal eligibility, legal exceptions, and progressive tax brackets are not determined here. Thresholds stay constant; each 12-month model year is treated as a tax year.</p>
      <p className="text-xs text-primary"><a href="https://www.irs.gov/publications/p936">Mortgage-interest deduction rules</a> · <a href="https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-exceptions-to-tax-on-early-distributions">Early distribution rules</a> · <a href="https://www.consumerfinance.gov/ask-cfpb/when-can-i-remove-private-mortgage-insurance-pmi-from-my-loan-en-202/">Insurance cancellation rules</a></p>
    </div></details></section>
    <section className={panel}><details><summary className="text-lg font-semibold cursor-pointer">Financial independence and market simulations</summary><FieldGrid className="mt-4">{([
      ['currentAge', 'Current age'], ['annualSpending', 'Annual spending excluding modeled debt ($)'], ['withdrawalPercent', 'Annual withdrawal rate (%)'], ['inflation', 'Annual inflation (%)'], ['stockPercent', 'Stocks in simulated portfolio (%)'], ['simulations', 'Simulation runs (50–1000)'], ['seed', 'Repeatable simulation seed'],
    ] as [NumericKey, string][]).map(([key, label]) => numeric(key, label))}</FieldGrid><p className="text-xs text-foreground-secondary mt-3">Remaining allocation is bonds. Simulations resample paired stock/bond years from 1928–2024 with the same path for all strategies. Each annual return is spread evenly across its months; inflation uses your fixed assumption.</p></details></section>
    <div className="flex flex-wrap items-center gap-3"><button className={button} onClick={() => apply()}>Update comparison</button><button className={button} disabled={simulating} onClick={simulate}>{simulating ? 'Simulating…' : 'Run market simulations'}</button>{simulating && <button className={button} onClick={() => { worker.current?.terminate(); setSimulating(false); }}>Cancel simulation</button>}{dirty && <p role="status" className="text-sm text-warning">Inputs changed. Update the comparison to apply them.</p>}</div>
    {shortfall && <p role="alert" className="text-sm text-error">A payment or fee exceeds the fixed budget. Results with unfunded payments are not feasible plans. Increase extra cash or revise the lender events.</p>}
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">{STRATEGIES.map(k => { const p = result.plans[k]; const diff = p.final.netWorth - result.plans.invest.final.netWorth; return <section className={panel} key={k}><h2 className="text-lg font-semibold">{STRATEGY_NAMES[k]}</h2><p className="text-xs text-foreground-secondary">After-tax investments + cash − debt at year {applied.years}</p><p className={`text-2xl font-mono ${p.final.netWorth < 0 ? 'text-negative' : ''}`}>{money.format(p.final.netWorth)}</p><dl className="space-y-2 text-sm">{[
      ['Difference vs investing', money.format(diff)], ['Investments before exit tax', money.format(p.final.investments)], ['Investments after exit tax', money.format(p.final.afterTaxInvestments)], ['Protected cash', money.format(applied.reserve)], ['Remaining debt', money.format(p.final.debt)], ['Interest paid', money.format(p.final.interest)], ['Interest saved vs investing', money.format(result.plans.invest.final.interest - p.final.interest)], ['Deduction benefit', money.format(p.final.taxBenefit)], ['Taxes paid before exit', money.format(p.final.taxes)], ['Investment/lender fees', money.format(p.final.fees)], ['Mortgage insurance', money.format(p.final.insurance)], ['Unfunded payments/fees', money.format(p.final.shortfall)], ['Debt-free', p.payoffMonth === null ? 'Beyond horizon' : p.payoffMonth === 0 ? 'Today' : monthToLabel(p.payoffMonth)], ['First independence threshold', p.financialIndependenceMonth === null ? 'Beyond horizon' : `Age ${(applied.currentAge + p.financialIndependenceMonth / 12).toFixed(1)}`],
    ].map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className="text-foreground-secondary">{label}</dt><dd className={`font-mono text-right ${label === 'Difference vs investing' && diff < 0 ? 'text-negative' : ''}`}>{value}</dd></div>)}</dl><details><summary className="text-sm text-primary cursor-pointer">Per-debt payoff</summary>{p.debts.map(d => <p key={d.id} className="text-sm mt-2">{d.name}: <span className="font-mono">{d.payoffMonth === null ? `${money.format(d.balance)} remaining` : d.payoffMonth === 0 ? 'Today' : monthToLabel(d.payoffMonth)}</span></p>)}</details><button className="text-primary text-sm" onClick={() => explain(k)}>Explain this number<span className="sr-only"> for {STRATEGY_NAMES[k]}</span></button><button className={button} disabled={busy || dirty || loadedId === null || shortfall} onClick={() => run(async () => { await request('/api/tools/debt-vs-invest/adopt', 'POST', { scenarioId: loadedId, strategy: k, scenario: applied }); setMessage('Strategy recorded in the existing Living Plan decision journal. No payment or investment was executed.'); })}>Record in Living Plan<span className="sr-only">: {STRATEGY_NAMES[k]}</span></button></section>; })}</div>
    <p className="text-xs text-foreground-secondary">Save applied inputs before recording a decision. This adds a journal entry to an existing plan; it does not replace its forecast. <Link className="text-primary" href="/planning/plan">Living Plan</Link> · <Link className="text-primary" href="/actions">Action Center</Link></p>
    <section className={panel}><h2 className="text-lg font-semibold">After-tax projection</h2><p className="text-sm text-foreground-secondary">Unchanged home value is excluded. Debt reduction is not liquid cash; retirement withdrawals depend on eligibility.</p><ComparisonChart data={chartData.map(p => ({ ...p, year: p.year }))} /><Values data={chartData} /></section>
    <section className={panel}><h2 className="text-lg font-semibold">Return sensitivity and break-even</h2><p className="text-sm text-foreground-secondary">{result.identical ? 'Strategies have equal modeled values across the searched returns.' : result.breakEvenRates.length ? `Payoff and investing cross at approximately ${result.breakEvenRates.map(r => `${r.toFixed(2)}%`).join(', ')} effective annual return.` : 'No crossing found between −90% and 50% effective annual return.'} A five-point search refines sign changes; unusual rules can create additional crossings. Positive chart values favor that strategy over investing.</p><ComparisonChart data={result.sensitivity} sensitivity /><Values data={result.sensitivity} sensitivity /></section>
    {simulation && <SimulationResults result={simulation} />}
    <section className={panel}><h2 className="text-lg font-semibold">Tradeoffs and assumptions</h2><div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-foreground-secondary"><p><strong>Pay off debt:</strong> reduces interest and future obligations and may offer peace of mind. Mortgage equity is harder to access than cash.</p><p><strong>Invest:</strong> retains invested assets and potential growth. Returns can disappoint while payments continue; selling or withdrawing may incur tax.</p><p><strong>Split:</strong> advances both goals while retaining some liquidity and market risk. Repayment is slower than devoting all available cash to debt.</p></div><details><summary className="text-primary cursor-pointer text-sm">Detailed methodology</summary><ul className="list-disc pl-5 mt-3 space-y-2 text-sm text-foreground-secondary">{PLANNER_ASSUMPTIONS.map(a => <li key={a}>{a}</li>)}</ul></details><Link className="text-primary text-sm" href="/tools/fire-calculator">Financial independence calculator</Link></section>
    <ProvenanceModal trace={trace} isOpen={trace !== null} onClose={() => setTrace(null)} />
  </div>;
}

function Values({ data, sensitivity = false }: { data: Record<string, number>[]; sensitivity?: boolean }) {
  const keys = STRATEGIES.filter(k => !sensitivity || k !== 'invest');
  return <details><summary className="text-primary text-sm cursor-pointer">{sensitivity ? 'Sensitivity values' : 'Yearly values'}</summary><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="text-right p-2">{sensitivity ? 'Return (%)' : 'Year'}</th>{keys.map(k => <th key={k} className="text-right p-2">{STRATEGY_NAMES[k]}</th>)}</tr></thead><tbody>{data.map((p, i) => <tr key={i} className="border-t border-border"><th scope="row" className="text-right p-2 font-mono">{p[sensitivity ? 'rate' : 'year']}</th>{keys.map(k => <td className="text-right p-2 font-mono" key={k}>{money.format(p[k])}</td>)}</tr>)}</tbody></table></div></details>;
}

function DebtEditor({ debt: d, onChange, onMove, onRemove }: { debt: PlannerDebt; onChange: (patch: Partial<PlannerDebt>) => void; onMove?: () => void; onRemove?: () => void }) {
  return <div className="border border-border rounded-lg p-4 space-y-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{d.name}</h3><div className="flex gap-2"><button className={button} disabled={!onMove} onClick={onMove}>Move up<span className="sr-only"> {d.name}</span></button><button className={button} disabled={!onRemove} onClick={onRemove}>Remove<span className="sr-only"> {d.name}</span></button></div></div><FieldGrid><label><span className={LABEL}>Debt name</span><input className={INPUT} value={d.name} maxLength={100} onChange={e => onChange({ name: e.target.value })} /></label>{([['balance', 'Balance ($)'], ['rate', 'Annual interest rate (%)'], ['payment', 'Monthly principal + interest ($)']] as const).map(([key, label]) => <NumberField key={key} label={`${d.name}: ${label}`} value={d[key]} onChange={v => onChange({ [key]: v })} />)}</FieldGrid>
    <details><summary className="text-primary text-sm cursor-pointer">Insurance, penalties, rate changes, recasting, and refinancing</summary><div className="space-y-4 mt-4"><p className="text-xs text-foreground-secondary">Enter lender-confirmed terms. Exclude property taxes and homeowners insurance. Month zero means today. Zero cancellation month means no date-based cancellation; zero extra-payment limit means unlimited. Events before the comparison horizon only affect that horizon.</p><FieldGrid>{([
      ['eligibleInterestPercent', 'Eligible interest after qualified-loan limits (%)'], ['insurance', 'Monthly mortgage insurance ($)'], ['cancelInsuranceBalance', 'Confirmed insurance cancellation balance ($)'], ['cancelInsuranceMonth', 'Confirmed cancellation month (0 = none)'], ['penaltyPercent', 'Penalty on extra principal (%)'], ['penaltyThroughMonth', 'Penalty applies through month'], ['annualExtraLimit', 'Annual extra-principal limit ($; 0 = unlimited)'],
    ] as const).map(([key, label]) => <NumberField key={key} label={`${d.name}: ${label}`} value={d[key]} onChange={v => onChange({ [key]: v })} />)}</FieldGrid>
    <h4 className="font-semibold text-sm">Variable-rate schedule</h4>{d.rateChanges.map((event, i) => <div key={i} className="space-y-2"><FieldGrid>{([['month', 'Rate change month'], ['rate', 'New annual rate (%)'], ['payment', 'New required monthly payment ($)']] as const).map(([key, label]) => <NumberField key={key} label={label} value={event[key]} onChange={v => onChange({ rateChanges: d.rateChanges.map((e, j) => i === j ? { ...e, [key]: v } : e) })} />)}</FieldGrid><button className={button} onClick={() => onChange({ rateChanges: d.rateChanges.filter((_, j) => i !== j) })}>Remove rate change</button></div>)}<button className={button} disabled={d.rateChanges.length >= 20} onClick={() => onChange({ rateChanges: [...d.rateChanges, { month: (d.rateChanges.at(-1)?.month ?? 0) + 12, rate: d.rate, payment: d.payment }] })}>Add rate change</button>
    <label className="block text-sm"><input type="checkbox" className="mr-2" checked={d.recast !== null} onChange={e => onChange({ recast: e.target.checked ? { month: 12, remainingMonths: 240, fee: 0 } : null })} />Plan a recast</label>{d.recast && <FieldGrid>{([['month', 'Recast month'], ['remainingMonths', 'Remaining term in months'], ['fee', 'Recast fee ($)']] as const).map(([key, label]) => <NumberField key={key} label={label} value={d.recast![key]} onChange={v => onChange({ recast: { ...d.recast!, [key]: v } })} />)}</FieldGrid>}
    <label className="block text-sm"><input type="checkbox" className="mr-2" checked={d.refinance !== null} onChange={e => onChange({ refinance: e.target.checked ? { month: 24, rate: d.rate, termMonths: 240, cost: 0, financeCost: false } : null })} />Plan a refinance</label>{d.refinance && <><FieldGrid>{([['month', 'Refinance month'], ['rate', 'Refinance annual rate (%)'], ['termMonths', 'New term in months'], ['cost', 'Closing costs ($)']] as const).map(([key, label]) => <NumberField key={key} label={label} value={d.refinance![key]} onChange={v => onChange({ refinance: { ...d.refinance!, [key]: v } })} />)}</FieldGrid><label className="block text-sm"><input type="checkbox" className="mr-2" checked={d.refinance.financeCost} onChange={e => onChange({ refinance: { ...d.refinance!, financeCost: e.target.checked } })} />Finance costs and applicable payoff penalty</label></>}
    </div></details>
  </div>;
}
