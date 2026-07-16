'use client';

import PersonalImportWizard from '@/components/import/PersonalImportWizard';

export default function MintImportPage() {
    return (
        <PersonalImportWizard
            config={{
                source: 'mint',
                title: 'Import Mint',
                blurb: 'Bring your Mint transaction history into the current book with account and category mapping.',
                exportHint: (
                    <p>
                        In Mint, open <span className="font-mono text-xs">Transactions</span> and use{' '}
                        <span className="font-mono text-xs">Export all transactions</span> to download the
                        CSV (columns: Date, Description, Original Description, Amount, Transaction Type,
                        Category, Account Name, Labels, Notes). Amounts are unsigned — the debit/credit
                        type column determines the direction.
                    </p>
                ),
                dropHint: 'Drop the Mint transactions.csv here or click to browse',
            }}
        />
    );
}
