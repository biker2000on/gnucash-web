'use client';

import { useEffect, useState, Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import AccountLedger, { AccountTransaction } from '@/components/AccountLedger';
import { InvestmentAccount } from '@/components/InvestmentAccount';
import { DateRangePicker } from '@/components/ui/DateRangePicker';
import { useDateFilter } from '@/hooks/useDateFilter';
import { formatCurrency, applyBalanceReversal } from '@/lib/format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import Link from 'next/link';

interface AccountData {
    name: string;
    fullname: string;
    depth: number;
    account_type?: string;
    commodity_namespace?: string;
    guid1?: string;
    guid2?: string;
    guid3?: string;
    guid4?: string;
    guid5?: string;
    guid6?: string;
    level1?: string;
    level2?: string;
    level3?: string;
    level4?: string;
    level5?: string;
    level6?: string;
}

function AccountPageContent() {
    const params = useParams();
    const guid = params.guid as string;
    const { startDate, endDate, setDateFilter, isInitialized } = useDateFilter();
    const { balanceReversal } = useUserPreferences();

    const [account, setAccount] = useState<AccountData | null>(null);
    const [transactions, setTransactions] = useState<AccountTransaction[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isInitialized || !guid) return;

        async function fetchData() {
            setLoading(true);
            setError(null);
            try {
                // Fetch account metadata
                const accountRes = await fetch(`/api/accounts/${guid}/info`);
                if (accountRes.ok) {
                    const accountData = await accountRes.json();
                    setAccount(accountData);
                }

                // Fetch transactions with date filter
                const txParams = new URLSearchParams();
                txParams.set('limit', '100');
                txParams.set('offset', '0');
                if (startDate) txParams.set('startDate', startDate);
                if (endDate) txParams.set('endDate', endDate);

                const txRes = await fetch(`/api/accounts/${guid}/transactions?${txParams.toString()}`);
                if (!txRes.ok) throw new Error('Failed to fetch transactions');
                const txData = await txRes.json();
                setTransactions(txData);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
                setLoading(false);
            }
        }

        fetchData();
    }, [guid, startDate, endDate, isInitialized]);

    // Build breadcrumb path from the account hierarchy data
    const breadcrumbSegments: { name: string; guid: string }[] = [];
    if (account) {
        for (let i = 1; i <= (account.depth || 0); i++) {
            const levelName = account[`level${i}` as keyof AccountData];
            const levelGuid = account[`guid${i}` as keyof AccountData];
            if (levelName && levelGuid) {
                breadcrumbSegments.push({ name: String(levelName), guid: String(levelGuid) });
            }
        }
    }

    const currentBalance = transactions[0]?.running_balance;
    const commodityMnemonic = transactions[0]?.commodity_mnemonic;

    // Check if this is an investment account (non-currency commodity)
    const isInvestmentAccount = account?.commodity_namespace && account.commodity_namespace !== 'CURRENCY';

    return (
        <div className="space-y-6">
            <header className="flex flex-col lg:flex-row lg:justify-between lg:items-end gap-4">
                <div>
                    <nav className="flex items-center gap-2 text-xs text-foreground-muted uppercase tracking-widest mb-2">
                        <Link href="/accounts" className="hover:text-emerald-400 transition-colors">Accounts</Link>
                        <span>/</span>
                        <span className="text-foreground-secondary">{account?.name || 'Loading...'}</span>
                    </nav>
                    <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
                        {account?.name || 'Loading...'}
                        <span className="text-xs font-normal px-2 py-1 rounded bg-background-tertiary text-foreground-muted border border-border-hover uppercase tracking-tighter">Ledger</span>
                    </h1>
                    {/* Account Path Breadcrumb */}
                    {account?.fullname && (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-foreground-muted">
                            {breadcrumbSegments.map((segment, index) => (
                                <div key={segment.guid} className="flex items-center gap-1.5">
                                    {index > 0 && <span className="text-border-hover">:</span>}
                                    {index === breadcrumbSegments.length - 1 ? (
                                        <span className="text-foreground-secondary">{segment.name}</span>
                                    ) : (
                                        <Link
                                            href={`/accounts/${segment.guid}`}
                                            className="hover:text-emerald-400 transition-colors hover:underline"
                                        >
                                            {segment.name}
                                        </Link>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
                    <DateRangePicker
                        startDate={startDate}
                        endDate={endDate}
                        onChange={setDateFilter}
                    />
                    <div className="text-right pb-1">
                        <p className="text-xs text-foreground-muted uppercase tracking-widest font-bold">Current Balance</p>
                        <p className={`text-2xl font-mono font-bold ${currentBalance && applyBalanceReversal(parseFloat(currentBalance), account?.account_type || 'ASSET', balanceReversal) < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {currentBalance
                                ? formatCurrency(applyBalanceReversal(parseFloat(currentBalance), account?.account_type || 'ASSET', balanceReversal), commodityMnemonic)
                                : '$0.00'}
                        </p>
                    </div>
                </div>
            </header>

            {/* Investment Account View */}
            {isInvestmentAccount && (
                <InvestmentAccount accountGuid={guid} />
            )}

            {/* Transaction Ledger */}
            {loading ? (
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading transactions...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="bg-surface/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="text-rose-400">{error}</div>
                </div>
            ) : (
                <AccountLedger
                    accountGuid={guid}
                    initialTransactions={transactions}
                    startDate={startDate}
                    endDate={endDate}
                    accountType={account?.account_type}
                />
            )}
        </div>
    );
}

export default function AccountPage() {
    return (
        <Suspense fallback={
            <div className="space-y-6">
                <header>
                    <nav className="flex items-center gap-2 text-xs text-foreground-muted uppercase tracking-widest mb-2">
                        <span>Accounts</span>
                        <span>/</span>
                        <span className="text-foreground-secondary">Loading...</span>
                    </nav>
                    <h1 className="text-3xl font-bold text-foreground">Loading...</h1>
                </header>
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 shadow-2xl flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading...</span>
                    </div>
                </div>
            </div>
        }>
            <AccountPageContent />
        </Suspense>
    );
}
