'use client';

import { Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatCurrency } from '@/lib/format';

interface BudgetSummary {
    guid: string;
    name: string;
    num_periods: number;
}

interface BudgetAmountRow {
    account_guid: string;
    period_num: number;
    amount_decimal: string;
    account_name: string;
    account?: { account_type?: string };
}

interface BudgetDetail {
    guid: string;
    name: string;
    num_periods: number;
    amounts: BudgetAmountRow[];
}

/** Per-account monthly average, sign-corrected so income reads positive. */
interface AccountMonthly {
    guid: string;
    name: string;
    type: string;
    monthly: number;
}

function summarize(budget: BudgetDetail): Map<string, AccountMonthly> {
    const totals = new Map<string, AccountMonthly>();
    for (const row of budget.amounts) {
        const type = row.account?.account_type || 'EXPENSE';
        const raw = parseFloat(row.amount_decimal) || 0;
        const value = type === 'INCOME' ? -raw : raw;
        const existing = totals.get(row.account_guid);
        if (existing) {
            existing.monthly += value;
        } else {
            totals.set(row.account_guid, { guid: row.account_guid, name: row.account_name, type, monthly: value });
        }
    }
    const periods = Math.max(1, budget.num_periods);
    for (const acc of totals.values()) {
        acc.monthly = Math.round((acc.monthly / periods) * 100) / 100;
    }
    return totals;
}

function DeltaCell({ delta, type }: { delta: number; type: string }) {
    if (Math.abs(delta) < 0.005) {
        return <span className="text-foreground-muted">—</span>;
    }
    // Expense: spending less (negative delta) is good. Income: earning more is good.
    const good = type === 'INCOME' ? delta > 0 : delta < 0;
    return (
        <span className={good ? 'text-positive' : 'text-negative'}>
            {delta > 0 ? '+' : ''}{formatCurrency(delta)}
        </span>
    );
}

function ComparePageInner() {
    const searchParams = useSearchParams();
    const [budgets, setBudgets] = useState<BudgetSummary[]>([]);
    const [guidA, setGuidA] = useState<string>(searchParams.get('a') || '');
    const [guidB, setGuidB] = useState<string>(searchParams.get('b') || '');
    const [detailA, setDetailA] = useState<BudgetDetail | null>(null);
    const [detailB, setDetailB] = useState<BudgetDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/budgets')
            .then(res => (res.ok ? res.json() : Promise.reject(new Error('Failed to load budgets'))))
            .then((data: BudgetSummary[]) => setBudgets(data))
            .catch(err => setError(err instanceof Error ? err.message : 'Failed to load budgets'))
            .finally(() => setLoading(false));
    }, []);

    const loadDetail = useCallback(async (guid: string, set: (d: BudgetDetail | null) => void) => {
        if (!guid) {
            set(null);
            return;
        }
        try {
            const res = await fetch(`/api/budgets/${guid}`);
            if (!res.ok) throw new Error('Failed to load budget');
            set(await res.json());
        } catch {
            set(null);
            setError('Failed to load budget details');
        }
    }, []);

    useEffect(() => { loadDetail(guidA, setDetailA); }, [guidA, loadDetail]);
    useEffect(() => { loadDetail(guidB, setDetailB); }, [guidB, loadDetail]);

    const comparison = useMemo(() => {
        if (!detailA || !detailB) return null;
        const a = summarize(detailA);
        const b = summarize(detailB);
        const guids = new Set([...a.keys(), ...b.keys()]);
        const rows = [...guids].map(guid => {
            const ra = a.get(guid);
            const rb = b.get(guid);
            const type = (ra ?? rb)!.type;
            const monthlyA = ra?.monthly ?? 0;
            const monthlyB = rb?.monthly ?? 0;
            return {
                guid,
                name: (ra ?? rb)!.name,
                type,
                a: monthlyA,
                b: monthlyB,
                delta: Math.round((monthlyB - monthlyA) * 100) / 100,
            };
        });
        rows.sort((x, y) => x.type.localeCompare(y.type) || x.name.localeCompare(y.name));
        const totalOf = (type: string) => {
            const subset = rows.filter(r => r.type === type);
            return {
                a: subset.reduce((s, r) => s + r.a, 0),
                b: subset.reduce((s, r) => s + r.b, 0),
                count: subset.length,
            };
        };
        return { rows, expense: totalOf('EXPENSE'), income: totalOf('INCOME') };
    }, [detailA, detailB]);

    const selectClass =
        'px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm min-w-0 max-w-full';

    return (
        <div className="space-y-4 max-w-4xl">
            <PageHeader
                title="Compare budgets"
                subtitle="Side-by-side monthly amounts per account, with the change from A to B."
            />

            {error && (
                <div className="p-3 bg-rose-900/30 text-rose-400 border border-rose-800/50 rounded-md text-sm">
                    {error}
                </div>
            )}

            <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                    <span className="block text-xs text-foreground-secondary mb-1">Budget A</span>
                    <select value={guidA} onChange={e => setGuidA(e.target.value)} className={selectClass}>
                        <option value="">Select…</option>
                        {budgets.map(b => (
                            <option key={b.guid} value={b.guid}>{b.name}</option>
                        ))}
                    </select>
                </label>
                <span className="pb-2 text-xs text-foreground-muted">vs</span>
                <label className="block">
                    <span className="block text-xs text-foreground-secondary mb-1">Budget B</span>
                    <select value={guidB} onChange={e => setGuidB(e.target.value)} className={selectClass}>
                        <option value="">Select…</option>
                        {budgets.map(b => (
                            <option key={b.guid} value={b.guid}>{b.name}</option>
                        ))}
                    </select>
                </label>
            </div>

            {loading ? (
                <div className="text-sm text-foreground-secondary">Loading budgets…</div>
            ) : !comparison ? (
                <div className="bg-surface border border-border rounded-lg p-8 text-center text-sm text-foreground-muted">
                    Pick two budgets to compare.{' '}
                    {budgets.length === 0 && (
                        <>No budgets yet — <Link href="/budgets/new" className="text-primary hover:underline">generate one</Link>.</>
                    )}
                </div>
            ) : (
                <div className="bg-surface border border-border rounded-lg overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-xs text-foreground-secondary border-b border-border">
                                <th className="px-3 py-2 text-left font-medium">Account</th>
                                <th className="px-3 py-2 text-left font-medium w-20">Type</th>
                                <th className="px-3 py-2 text-right font-medium">{detailA?.name} /mo</th>
                                <th className="px-3 py-2 text-right font-medium">{detailB?.name} /mo</th>
                                <th className="px-3 py-2 text-right font-medium">Δ (B − A)</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {comparison.rows.map(row => (
                                <tr key={row.guid}>
                                    <td className="px-3 py-1.5 text-foreground">{row.name}</td>
                                    <td className="px-3 py-1.5 text-xs text-foreground-muted">{row.type}</td>
                                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground-secondary">
                                        {formatCurrency(row.a)}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground-secondary">
                                        {formatCurrency(row.b)}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                                        <DeltaCell delta={row.delta} type={row.type} />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            {comparison.income.count > 0 && (
                                <tr className="border-t border-border font-medium">
                                    <td className="px-3 py-2 text-foreground" colSpan={2}>Income total</td>
                                    <td className="px-3 py-2 text-right font-mono tabular-nums">{formatCurrency(comparison.income.a)}</td>
                                    <td className="px-3 py-2 text-right font-mono tabular-nums">{formatCurrency(comparison.income.b)}</td>
                                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                                        <DeltaCell delta={Math.round((comparison.income.b - comparison.income.a) * 100) / 100} type="INCOME" />
                                    </td>
                                </tr>
                            )}
                            <tr className={`font-medium ${comparison.income.count > 0 ? '' : 'border-t border-border'}`}>
                                <td className="px-3 py-2 text-foreground" colSpan={2}>Expense total</td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums">{formatCurrency(comparison.expense.a)}</td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums">{formatCurrency(comparison.expense.b)}</td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums">
                                    <DeltaCell delta={Math.round((comparison.expense.b - comparison.expense.a) * 100) / 100} type="EXPENSE" />
                                </td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}
        </div>
    );
}

export default function ComparePage() {
    return (
        <Suspense fallback={<div className="text-sm text-foreground-secondary">Loading…</div>}>
            <ComparePageInner />
        </Suspense>
    );
}
