import AccountLedger from '@/components/AccountLedger';
import Link from 'next/link';
import { query } from '@/lib/db';
import { formatCurrency } from '@/lib/format';

async function getAccountData(guid: string) {
    // We can use the existing accounts API to find the account name, 
    // or just fetch all and find it (inefficient but works for now since we have it)
    // Actually let's just fetch the account name from the DB directly here for efficiency
    const res = await query('SELECT name FROM accounts WHERE guid = $1', [guid]);
    return res.rows[0];
}

async function getInitialTransactions(guid: string) {
    const res = await fetch(`http://localhost:3000/api/accounts/${guid}/transactions?limit=100&offset=0`, { cache: 'no-store' });
    if (!res.ok) return [];
    return res.json();
}

export default async function AccountPage({ params }: { params: Promise<{ guid: string }> }) {
    const { guid } = await params;
    const [account, initialTransactions] = await Promise.all([
        getAccountData(guid),
        getInitialTransactions(guid)
    ]);

    if (!account) return <div className="p-8 text-neutral-400">Account not found.</div>;

    return (
        <div className="space-y-6">
            <header className="flex justify-between items-end">
                <div>
                    <nav className="flex items-center gap-2 text-xs text-neutral-500 uppercase tracking-widest mb-2">
                        <Link href="/accounts" className="hover:text-emerald-400 transition-colors">Accounts</Link>
                        <span>/</span>
                        <span className="text-neutral-400">{account.name}</span>
                    </nav>
                    <h1 className="text-3xl font-bold text-neutral-100 flex items-center gap-3">
                        {account.name}
                        <span className="text-xs font-normal px-2 py-1 rounded bg-neutral-800 text-neutral-500 border border-neutral-700 uppercase tracking-tighter">Ledger</span>
                    </h1>
                </div>
                <div className="text-right pb-1">
                    <p className="text-xs text-neutral-500 uppercase tracking-widest font-bold">Current Balance</p>
                    <p className={`text-2xl font-mono font-bold ${initialTransactions[0] && parseFloat(initialTransactions[0].running_balance) < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {initialTransactions[0]
                            ? formatCurrency(initialTransactions[0].running_balance, initialTransactions[0].commodity_mnemonic)
                            : '$0.00'}
                    </p>
                </div>
            </header>

            <AccountLedger accountGuid={guid} initialTransactions={initialTransactions} />
        </div>
    );
}
