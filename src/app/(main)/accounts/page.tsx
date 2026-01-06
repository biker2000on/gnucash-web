import AccountHierarchy from '@/components/AccountHierarchy';

async function getAccounts() {
    // Use absolute URL for server-side fetch in Next.js when needed, 
    // but here we can just fetch from the route if it's internal.
    // For simplicity and since we are on local, we'll use localhost.
    const res = await fetch('http://localhost:3000/api/accounts', { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch accounts');
    return res.json();
}

export default async function AccountsPage() {
    const accounts = await getAccounts();

    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-3xl font-bold text-neutral-100">Accounts</h1>
                <p className="text-neutral-500">Explore your GnuCash account structure.</p>
            </header>
            <AccountHierarchy accounts={accounts} />
        </div>
    );
}
