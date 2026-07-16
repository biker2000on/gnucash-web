'use client';

import PersonalImportWizard from '@/components/import/PersonalImportWizard';

export default function MonarchImportPage() {
    return (
        <PersonalImportWizard
            config={{
                source: 'monarch',
                title: 'Import Monarch Money',
                blurb: 'Import Monarch Money transactions into the current book with account and category mapping.',
                exportHint: (
                    <p>
                        In Monarch Money, go to{' '}
                        <span className="font-mono text-xs">Settings → Data → Download transactions</span>{' '}
                        (or use the download button on the Transactions page) to get the CSV (columns:
                        Date, Merchant, Category, Account, Original Statement, Notes, Amount, Tags).
                        Amounts are signed — negative means money out.
                    </p>
                ),
                dropHint: 'Drop the Monarch transactions CSV here or click to browse',
            }}
        />
    );
}
