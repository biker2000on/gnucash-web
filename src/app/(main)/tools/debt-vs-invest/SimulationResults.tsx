'use client';

import { useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { STRATEGIES, type DebtInvestmentStrategy } from '@/lib/debt-vs-invest';
import { STRATEGY_NAMES, type simulatePlanner } from '@/lib/debt-investment-planner';
import { SELECT } from '@/components/ui/form';

const money = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
export function SimulationResults({ result }: { result: ReturnType<typeof simulatePlanner> }) {
  const [strategy, setStrategy] = useState<DebtInvestmentStrategy>('payoff');
  const data = result.bands.map(row => ({ year: row.year, median: row[strategy], range: [row[`${strategy}Low`], row[`${strategy}High`]] }));
  return <section className="bg-surface border border-border rounded-lg p-4 sm:p-6 space-y-4">
    <h2 className="text-lg font-semibold text-foreground">Historical return simulations</h2>
    <p className="text-sm text-foreground-secondary">{result.runs} paired paths sample historical stock and bond years with replacement. Every strategy sees the same market path. The shaded band covers the 10th through 90th percentiles; it is not a guarantee. Inflation remains your chosen assumption.</p>
    {result.invalidRuns > 0 && <p role="alert" className="text-sm text-foreground-secondary">{result.invalidRuns} paths exceeded the available monthly budget. Probabilities are unavailable; fix the funding shortfall before using this comparison.</p>}
    <div className="overflow-x-auto"><table className="w-full text-sm text-left"><caption className="text-left text-foreground-secondary pb-2">Final after-tax net position and chance of finishing ahead of investing</caption><thead><tr>{['Strategy', '10th percentile', 'Median', '90th percentile', 'Ahead of investing', 'Tied with investing'].map(v => <th key={v} className="p-2">{v}</th>)}</tr></thead><tbody>{result.summaries.map(row => <tr key={row.strategy} className="border-t border-border"><th className="p-2">{STRATEGY_NAMES[row.strategy]}</th>{[row.low, row.median, row.high].map((v, i) => <td key={i} className={`p-2 font-mono ${v < 0 ? 'text-negative' : ''}`}>{money(v)}</td>)}<td className="p-2">{result.invalidRuns ? 'Unavailable' : `${row.aheadPercent.toFixed(1)}%`}</td><td className="p-2">{result.invalidRuns ? 'Unavailable' : `${row.tiePercent.toFixed(1)}%`}</td></tr>)}</tbody></table></div>
    <label className="block text-sm text-foreground-secondary">Chart strategy<select className={SELECT} value={strategy} onChange={e => setStrategy(e.target.value as DebtInvestmentStrategy)}>{STRATEGIES.map(k => <option key={k} value={k}>{STRATEGY_NAMES[k]}</option>)}</select></label>
    <div className="h-72" role="img" aria-label={`${STRATEGY_NAMES[strategy]} median and 10th to 90th percentile net position. Exact values in the table below.`}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="year" /><YAxis tickFormatter={v => money(Number(v))} width={100} /><Tooltip formatter={v => Array.isArray(v) ? v.map(n => money(Number(n))).join(' – ') : money(Number(v))} /><Area dataKey="range" name="10th–90th percentile" fill="var(--primary)" stroke="none" fillOpacity={0.15} isAnimationActive={false} /><Line dataKey="median" name="Median" stroke="var(--primary)" dot={false} isAnimationActive={false} /></ComposedChart></ResponsiveContainer></div>
    <details><summary className="cursor-pointer text-sm text-primary">Annual percentile values</summary><div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr><th className="p-2">Year</th><th className="p-2">10th percentile</th><th className="p-2">Median</th><th className="p-2">90th percentile</th></tr></thead><tbody>{data.map(row => <tr key={row.year} className="border-t border-border"><td className="p-2">{row.year}</td>{[row.range[0], row.median, row.range[1]].map((v, i) => <td key={i} className={`p-2 font-mono ${v < 0 ? 'text-negative' : ''}`}>{money(v)}</td>)}</tr>)}</tbody></table></div></details>
  </section>;
}
