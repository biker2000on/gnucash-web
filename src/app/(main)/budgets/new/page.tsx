'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountPickerModal } from '@/components/budget/AccountPickerModal';
import { useToast } from '@/contexts/ToastContext';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { formatCurrency } from '@/lib/format';

type Source = 'history' | 'pct-of-income' | 'zero-based';

interface PreviewLine {
    accountGuid: string;
    name: string;
    fullname: string;
    type: string;
    amount: number;
    avgMonthly: number;
    monthly: number[];
}

interface Row extends PreviewLine {
    excluded: boolean;
}

const SOURCES: Array<{ id: Source; label: string; detail: string }> = [
    {
        id: 'history',
        label: 'From history',
        detail: 'Suggest a monthly amount per expense account from your trailing actuals.',
    },
    {
        id: 'pct-of-income',
        label: '% of income',
        detail: '50/30/20-style allocation of monthly income across needs, wants, and savings.',
    },
    {
        id: 'zero-based',
        label: 'Zero-based',
        detail: 'Every account starts at $0 — allocate each dollar yourself.',
    },
];

export default function NewBudgetPage() {
    const router = useRouter();
    const toast = useToast();

    // Step 1 — source + options
    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [source, setSource] = useState<Source>('history');
    const [months, setMonths] = useState(12);
    const [statistic, setStatistic] = useState<'median' | 'mean'>('median');
    const [roundTo, setRoundTo] = useState(5);
    const [includeIncome, setIncludeIncome] = useState(false);
    const [incomeOverride, setIncomeOverride] = useState('');

    // Step 2 — preview
    const [rows, setRows] = useState<Row[]>([]);
    const [previewIncome, setPreviewIncome] = useState<number | null>(null);
    const [filter, setFilter] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const filterRef = useRef<HTMLInputElement>(null);

    // Step 3 — name + periods
    const currentYear = new Date().getFullYear();
    const [name, setName] = useState(`Budget ${currentYear}`);
    const [numPeriods, setNumPeriods] = useState(12);
    const [startMonth, setStartMonth] = useState(`${currentYear}-01`);
    const [creating, setCreating] = useState(false);

    const included = useMemo(() => rows.filter(r => !r.excluded), [rows]);
    const includedTotal = useMemo(() => included.reduce((s, r) => s + (r.amount || 0), 0), [included]);
    const filteredRows = useMemo(() => {
        const term = filter.trim().toLowerCase();
        if (!term) return rows;
        return rows.filter(r => r.fullname.toLowerCase().includes(term));
    }, [rows, filter]);

    const loadPreview = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/budgets/generate?preview=true', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source,
                    months,
                    statistic,
                    roundTo,
                    includeIncome,
                    preview: true,
                    ...(source === 'pct-of-income' && incomeOverride.trim() !== ''
                        ? { monthlyIncome: parseFloat(incomeOverride) || 0 }
                        : {}),
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to generate preview');
            }
            const data = await res.json();
            setRows((data.lines as PreviewLine[]).map(l => ({ ...l, excluded: false })));
            setPreviewIncome(typeof data.monthlyIncome === 'number' ? data.monthlyIncome : null);
            setStep(2);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to generate preview');
        } finally {
            setLoading(false);
        }
    }, [source, months, statistic, roundTo, includeIncome, incomeOverride]);

    const setRowAmount = useCallback((guid: string, value: string) => {
        const parsed = parseFloat(value);
        setRows(prev => prev.map(r =>
            r.accountGuid === guid ? { ...r, amount: Number.isFinite(parsed) ? parsed : 0 } : r
        ));
    }, []);

    const toggleRow = useCallback((guid: string) => {
        setRows(prev => prev.map(r => (r.accountGuid === guid ? { ...r, excluded: !r.excluded } : r)));
    }, []);

    const addAccount = useCallback((account: { guid: string; name: string; account_type: string; full_name?: string }) => {
        setRows(prev => {
            if (prev.some(r => r.accountGuid === account.guid)) return prev;
            const row: Row = {
                accountGuid: account.guid,
                name: account.name,
                fullname: account.full_name || account.name,
                type: account.account_type,
                amount: 0,
                avgMonthly: 0,
                monthly: [],
                excluded: false,
            };
            return [...prev, row].sort((a, b) => a.fullname.localeCompare(b.fullname));
        });
    }, []);

    const createBudget = useCallback(async () => {
        if (creating || !name.trim() || included.length === 0) return;
        setCreating(true);
        setError(null);
        try {
            const res = await fetch('/api/budgets/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim(),
                    source,
                    months,
                    statistic,
                    roundTo,
                    includeIncome,
                    numPeriods,
                    startMonth,
                    lines: included.map(r => ({ accountGuid: r.accountGuid, amount: Math.max(0, r.amount || 0) })),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to create budget');
            toast.success(`Budget "${name.trim()}" created`);
            router.push(`/budgets/${data.budgetGuid}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create budget');
            setCreating(false);
        }
    }, [creating, name, included, source, months, statistic, roundTo, includeIncome, numPeriods, startMonth, toast, router]);

    const canAdvance = step === 1 ? !loading : step === 2 ? included.length > 0 : name.trim() !== '' && !creating;

    const advance = useCallback(() => {
        if (step === 1 && !loading) loadPreview();
        else if (step === 2 && included.length > 0) setStep(3);
        else if (step === 3) createBudget();
    }, [step, loading, loadPreview, included.length, createBudget]);

    const goBack = useCallback(() => {
        if (step > 1) setStep((step - 1) as 1 | 2);
    }, [step]);

    // Shortcuts fire only outside inputs (global scope) and never while the
    // account picker modal is open (it owns Escape).
    useKeyboardShortcut('budget-new-advance', 'Enter', 'Next step / create budget', advance, 'page', !pickerOpen && canAdvance);
    useKeyboardShortcut('budget-new-back', 'Escape', 'Previous step', goBack, 'page', !pickerOpen && step > 1);
    useKeyboardShortcut(
        'budget-new-filter',
        '/',
        'Filter preview accounts',
        () => filterRef.current?.focus(),
        'page',
        !pickerOpen && step === 2
    );

    const stepTitle = step === 1 ? 'Source' : step === 2 ? 'Preview' : 'Name & periods';

    return (
        <div className="space-y-4 max-w-4xl">
            <PageHeader
                title="New budget"
                subtitle="Generate a budget from history or a template, review the amounts, then create it."
            />

            {/* Step indicator: plain text, no graphics */}
            <div className="text-xs text-foreground-muted">
                Step {step} of 3 · <span className="text-foreground-secondary">{stepTitle}</span>
            </div>

            {error && (
                <div className="p-3 bg-rose-900/30 text-rose-400 border border-rose-800/50 rounded-md text-sm">
                    {error}
                </div>
            )}

            {/* ---- Step 1: source + options ---- */}
            {step === 1 && (
                <div className="bg-surface border border-border rounded-lg divide-y divide-border">
                    <div className="p-4 space-y-2">
                        {SOURCES.map(s => (
                            <label
                                key={s.id}
                                className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                                    source === s.id
                                        ? 'border-primary/60 bg-primary-light'
                                        : 'border-border hover:border-border-hover'
                                }`}
                            >
                                <input
                                    type="radio"
                                    name="source"
                                    checked={source === s.id}
                                    onChange={() => setSource(s.id)}
                                    className="mt-0.5 accent-teal-500"
                                />
                                <span>
                                    <span className="block text-sm font-medium text-foreground">{s.label}</span>
                                    <span className="block text-xs text-foreground-secondary mt-0.5">{s.detail}</span>
                                </span>
                            </label>
                        ))}
                    </div>

                    <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                        <label className="block">
                            <span className="block text-xs text-foreground-secondary mb-1">Lookback</span>
                            <select
                                value={months}
                                onChange={e => setMonths(parseInt(e.target.value, 10))}
                                className="w-full px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm"
                            >
                                <option value={3}>3 months</option>
                                <option value={6}>6 months</option>
                                <option value={12}>12 months</option>
                            </select>
                        </label>
                        <label className="block">
                            <span className="block text-xs text-foreground-secondary mb-1">Statistic</span>
                            <select
                                value={statistic}
                                onChange={e => setStatistic(e.target.value as 'median' | 'mean')}
                                disabled={source === 'zero-based'}
                                className="w-full px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm disabled:opacity-50"
                            >
                                <option value="median">Median (resists one-offs)</option>
                                <option value="mean">Mean (smears irregular)</option>
                            </select>
                        </label>
                        <label className="block">
                            <span className="block text-xs text-foreground-secondary mb-1">Round to</span>
                            <select
                                value={roundTo}
                                onChange={e => setRoundTo(parseFloat(e.target.value))}
                                disabled={source === 'zero-based'}
                                className="w-full px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm disabled:opacity-50"
                            >
                                <option value={1}>$1</option>
                                <option value={5}>$5</option>
                                <option value={10}>$10</option>
                                <option value={25}>$25</option>
                            </select>
                        </label>
                        <label className="flex items-end gap-2 pb-1.5">
                            <input
                                type="checkbox"
                                checked={includeIncome}
                                onChange={e => setIncludeIncome(e.target.checked)}
                                className="accent-teal-500"
                            />
                            <span className="text-xs text-foreground-secondary">Include income accounts</span>
                        </label>
                        {source === 'pct-of-income' && (
                            <label className="block col-span-2">
                                <span className="block text-xs text-foreground-secondary mb-1">
                                    Monthly income (blank = estimate from history)
                                </span>
                                <input
                                    type="number"
                                    min={0}
                                    step={100}
                                    value={incomeOverride}
                                    onChange={e => setIncomeOverride(e.target.value)}
                                    placeholder="auto"
                                    className="w-full px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm font-mono tabular-nums text-right"
                                />
                            </label>
                        )}
                    </div>
                </div>
            )}

            {/* ---- Step 2: preview table ---- */}
            {step === 2 && (
                <div className="bg-surface border border-border rounded-lg">
                    <div className="p-3 flex items-center gap-2 border-b border-border">
                        <input
                            ref={filterRef}
                            type="text"
                            value={filter}
                            onChange={e => setFilter(e.target.value)}
                            placeholder="Filter accounts…  ( / )"
                            className="flex-1 max-w-xs px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm placeholder-foreground-muted"
                        />
                        <button
                            onClick={() => setPickerOpen(true)}
                            className="px-3 py-1.5 text-sm border border-border rounded-md text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                        >
                            + Add account
                        </button>
                        {previewIncome !== null && (
                            <span className="ml-auto text-xs text-foreground-muted font-mono tabular-nums">
                                income est. {formatCurrency(previewIncome)}/mo
                            </span>
                        )}
                    </div>

                    <div className="max-h-[28rem] overflow-y-auto">
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-surface">
                                <tr className="text-xs text-foreground-secondary border-b border-border">
                                    <th className="px-3 py-2 text-left font-medium w-10">Use</th>
                                    <th className="px-3 py-2 text-left font-medium">Account</th>
                                    <th className="px-3 py-2 text-right font-medium">Avg/mo</th>
                                    <th className="px-3 py-2 text-right font-medium">Monthly amount</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {filteredRows.length === 0 && (
                                    <tr>
                                        <td colSpan={4} className="px-3 py-6 text-center text-foreground-muted text-sm">
                                            {rows.length === 0 ? 'No accounts with activity in the window.' : 'No accounts match the filter.'}
                                        </td>
                                    </tr>
                                )}
                                {filteredRows.map(row => (
                                    <tr key={row.accountGuid} className={row.excluded ? 'opacity-40' : ''}>
                                        <td className="px-3 py-1.5">
                                            <input
                                                type="checkbox"
                                                checked={!row.excluded}
                                                onChange={() => toggleRow(row.accountGuid)}
                                                className="accent-teal-500"
                                                aria-label={`Include ${row.fullname}`}
                                            />
                                        </td>
                                        <td className="px-3 py-1.5">
                                            <span className="text-foreground">{row.fullname}</span>
                                            {row.type === 'INCOME' && (
                                                <span className="ml-2 text-[10px] uppercase text-secondary">income</span>
                                            )}
                                        </td>
                                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground-muted">
                                            {row.monthly.length > 0 ? formatCurrency(row.avgMonthly) : '—'}
                                        </td>
                                        <td className="px-3 py-1.5 text-right">
                                            <input
                                                type="number"
                                                min={0}
                                                step={1}
                                                value={row.amount}
                                                disabled={row.excluded}
                                                onChange={e => setRowAmount(row.accountGuid, e.target.value)}
                                                className="w-28 px-2 py-1 bg-background-tertiary border border-border rounded-md text-foreground text-sm font-mono tabular-nums text-right disabled:opacity-50"
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="border-t border-border text-sm">
                                    <td colSpan={3} className="px-3 py-2 text-foreground-secondary">
                                        {included.length} of {rows.length} accounts included
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono tabular-nums font-medium text-foreground">
                                        {formatCurrency(includedTotal)}/mo
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}

            {/* ---- Step 3: name + periods ---- */}
            {step === 3 && (
                <div className="bg-surface border border-border rounded-lg p-4 space-y-4 max-w-lg">
                    <label className="block">
                        <span className="block text-xs text-foreground-secondary mb-1">Budget name</span>
                        <input
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' && canAdvance) {
                                    e.preventDefault();
                                    createBudget();
                                }
                            }}
                            autoFocus
                            className="w-full px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm"
                        />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                            <span className="block text-xs text-foreground-secondary mb-1">Periods (months)</span>
                            <input
                                type="number"
                                min={1}
                                max={60}
                                value={numPeriods}
                                onChange={e => setNumPeriods(Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 12)))}
                                className="w-full px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm font-mono tabular-nums text-right"
                            />
                        </label>
                        <label className="block">
                            <span className="block text-xs text-foreground-secondary mb-1">Start month</span>
                            <input
                                type="month"
                                value={startMonth}
                                onChange={e => setStartMonth(e.target.value)}
                                className="w-full px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm font-mono tabular-nums"
                            />
                        </label>
                    </div>
                    <div className="text-xs text-foreground-muted">
                        {included.length} accounts · {formatCurrency(includedTotal)}/mo ·{' '}
                        <span className="font-mono tabular-nums">{formatCurrency(includedTotal * numPeriods)}</span> total over {numPeriods} periods
                    </div>
                </div>
            )}

            {/* ---- Nav ---- */}
            <div className="flex items-center justify-between">
                <button
                    onClick={goBack}
                    disabled={step === 1}
                    className="px-3 py-1.5 text-sm text-foreground-secondary hover:text-foreground disabled:opacity-40 transition-colors"
                >
                    ← Back <span className="text-foreground-muted text-xs ml-1">Esc</span>
                </button>
                <button
                    onClick={advance}
                    disabled={!canAdvance}
                    className="px-4 py-1.5 text-sm bg-primary hover:bg-primary-hover disabled:opacity-50 text-primary-foreground rounded-md transition-colors"
                >
                    {step === 1 ? (loading ? 'Generating…' : 'Preview →') : step === 2 ? 'Continue →' : creating ? 'Creating…' : 'Create budget'}
                    <span className="text-primary-foreground/60 text-xs ml-1.5">↵</span>
                </button>
            </div>

            <AccountPickerModal
                isOpen={pickerOpen}
                onClose={() => setPickerOpen(false)}
                existingAccountGuids={rows.map(r => r.accountGuid)}
                onSelect={addAccount}
            />
        </div>
    );
}
