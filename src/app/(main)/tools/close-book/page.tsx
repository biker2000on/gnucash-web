'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface PreviewAccount {
    guid: string;
    fullname: string;
    account_type: 'INCOME' | 'EXPENSE';
    balance: number;
}

interface Preview {
    closeDate: string;
    accounts: PreviewAccount[];
    incomeTotal: number;
    expenseTotal: number;
    netIncome: number;
    currencies: string[];
}

export default function CloseBookPage() {
    const { success, error } = useToast();
    const lastYearEnd = `${new Date().getFullYear() - 1}-12-31`;
    const [date, setDate] = useState(lastYearEnd);
    const [equityGuid, setEquityGuid] = useState<string>('');
    const [preview, setPreview] = useState<Preview | null>(null);
    const [loading, setLoading] = useState(false);
    const [posting, setPosting] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [result, setResult] = useState<{ transactionGuids: string[]; skippedCurrencies: string[] } | null>(null);

    const loadPreview = useCallback((d: string) => {
        setLoading(true);
        setResult(null);
        fetch(`/api/tools/close-book?date=${d}`)
            .then(r => (r.ok ? r.json() : null))
            .then(data => setPreview(data))
            .catch(() => setPreview(null))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        loadPreview(date);
    }, [date, loadPreview]);

    const execute = async () => {
        setPosting(true);
        try {
            const res = await fetch('/api/tools/close-book', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date, equityAccountGuid: equityGuid }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body?.error ?? 'Failed');
            setResult(body);
            success(`Posted ${body.transactionGuids.length} closing transaction(s)`);
            loadPreview(date);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to post closing entries');
        } finally {
            setPosting(false);
            setConfirming(false);
        }
    };

    const income = preview?.accounts.filter(a => a.account_type === 'INCOME') ?? [];
    const expense = preview?.accounts.filter(a => a.account_type === 'EXPENSE') ?? [];

    return (
        <div className="max-w-4xl space-y-6">
            <PageHeader
                title="Close Book"
                subtitle="Post year-end closing entries that zero income and expense accounts into equity — the same operation as GnuCash desktop's Tools → Close Book."
            />

            <div className="bg-surface border border-border rounded-lg p-6 space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                    <label className="block">
                        <span className="text-xs uppercase tracking-wider text-foreground-tertiary">Closing date</span>
                        <input
                            type="date"
                            value={date}
                            onChange={e => setDate(e.target.value)}
                            className="mt-1 block w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono"
                        />
                    </label>
                    <div>
                        <span className="text-xs uppercase tracking-wider text-foreground-tertiary">Close into (equity account)</span>
                        <div className="mt-1">
                            <AccountSelector
                                value={equityGuid}
                                onChange={guid => setEquityGuid(guid ?? '')}
                                accountTypes={['EQUITY']}
                                placeholder="Equity:Retained Earnings…"
                            />
                        </div>
                    </div>
                </div>
                <p className="text-xs text-foreground-muted leading-relaxed">
                    Balances are cumulative through the closing date, so running this after a previous close
                    only moves activity since that close. The posted transactions are ordinary transactions —
                    they appear in ledgers and can be undone from Settings → History.
                </p>
            </div>

            {loading ? (
                <div className="text-sm text-foreground-tertiary py-8 text-center">Computing balances…</div>
            ) : preview && preview.accounts.length === 0 ? (
                <div className="text-sm text-foreground-tertiary py-8 text-center border border-border rounded-lg">
                    Nothing to close — all income and expense balances are zero through {date}.
                </div>
            ) : preview ? (
                <>
                    <div className="grid sm:grid-cols-3 gap-4">
                        <div className="bg-surface border border-border rounded-lg p-4">
                            <div className="text-xs uppercase tracking-wider text-foreground-tertiary mb-1">Income to close</div>
                            <div className="text-xl font-mono text-positive" style={TNUM}>{formatCurrency(Math.abs(preview.incomeTotal))}</div>
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-4">
                            <div className="text-xs uppercase tracking-wider text-foreground-tertiary mb-1">Expenses to close</div>
                            <div className="text-xl font-mono text-negative" style={TNUM}>{formatCurrency(preview.expenseTotal)}</div>
                        </div>
                        <div className="bg-surface border border-border rounded-lg p-4">
                            <div className="text-xs uppercase tracking-wider text-foreground-tertiary mb-1">Net income → equity</div>
                            <div className={`text-xl font-mono ${preview.netIncome >= 0 ? 'text-positive' : 'text-negative'}`} style={TNUM}>
                                {formatCurrency(preview.netIncome)}
                            </div>
                        </div>
                    </div>

                    {[{ label: 'Income accounts', rows: income }, { label: 'Expense accounts', rows: expense }].map(group => (
                        group.rows.length > 0 && (
                            <div key={group.label} className="border border-border rounded-lg overflow-hidden">
                                <div className="px-4 py-2 bg-background-secondary text-xs uppercase tracking-wider text-foreground-tertiary font-semibold">
                                    {group.label} ({group.rows.length})
                                </div>
                                <table className="w-full text-sm">
                                    <tbody className="divide-y divide-border">
                                        {group.rows.map(a => (
                                            <tr key={a.guid}>
                                                <td className="px-4 py-2 text-foreground-secondary">{a.fullname}</td>
                                                <td className="px-4 py-2 text-right font-mono text-foreground" style={TNUM}>
                                                    {formatCurrency(Math.abs(a.balance))}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )
                    ))}

                    <div className="flex items-center gap-3">
                        {!confirming ? (
                            <button
                                onClick={() => setConfirming(true)}
                                disabled={!equityGuid || posting}
                                className="px-6 py-3 text-sm font-semibold bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors duration-150 disabled:opacity-50"
                            >
                                Close book as of {date}
                            </button>
                        ) : (
                            <>
                                <span className="text-sm text-foreground-secondary">
                                    Post {preview.accounts.length + 2} splits across closing transactions?
                                </span>
                                <button
                                    onClick={execute}
                                    disabled={posting}
                                    className="px-4 py-2 text-sm font-semibold bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors duration-150 disabled:opacity-50"
                                >
                                    {posting ? 'Posting…' : 'Confirm'}
                                </button>
                                <button
                                    onClick={() => setConfirming(false)}
                                    className="px-4 py-2 text-sm border border-border rounded-md text-foreground-secondary hover:text-foreground transition-colors duration-150"
                                >
                                    Cancel
                                </button>
                            </>
                        )}
                        {!equityGuid && (
                            <span className="text-xs text-foreground-muted">Pick an equity account first.</span>
                        )}
                    </div>
                </>
            ) : (
                <div className="text-sm text-negative py-4">Failed to load the preview.</div>
            )}

            {result && (
                <div className="border border-primary/40 bg-primary-light rounded-lg p-4 text-sm space-y-2">
                    <div className="text-foreground font-medium">
                        Closing entries posted ({result.transactionGuids.length} transaction{result.transactionGuids.length !== 1 ? 's' : ''}).
                    </div>
                    {result.skippedCurrencies.length > 0 && (
                        <div className="text-warning">
                            {result.skippedCurrencies.length} currency group(s) skipped — their commodity differs
                            from the chosen equity account. Re-run with a matching equity account to close them.
                        </div>
                    )}
                    <div className="text-foreground-secondary">
                        Review them in the <Link className="text-primary hover:underline" href="/ledger?search=Closing%20Entries">general ledger</Link>{' '}
                        or undo from <Link className="text-primary hover:underline" href="/settings/history">Settings → History</Link>.
                    </div>
                </div>
            )}
        </div>
    );
}
