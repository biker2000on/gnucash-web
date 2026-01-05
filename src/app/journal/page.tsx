import TransactionJournal from '@/components/TransactionJournal';

async function getTransactions() {
    const res = await fetch('http://localhost:3000/api/transactions', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch transactions');
    return res.json();
}

export default async function JournalPage() {
    const res = await fetch('http://localhost:3000/api/transactions?limit=150&offset=0', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch transactions');
    const initialTransactions = await res.json();

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-3xl font-bold text-neutral-100">Journal</h1>
                <p className="text-neutral-500">View recent transactions and their splits.</p>
            </header>
            <TransactionJournal initialTransactions={initialTransactions} />
        </div>
    );
}
