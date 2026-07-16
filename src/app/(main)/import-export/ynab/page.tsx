'use client';

import PersonalImportWizard from '@/components/import/PersonalImportWizard';

export default function YnabImportPage() {
    return (
        <PersonalImportWizard
            config={{
                source: 'ynab',
                title: 'Import YNAB',
                blurb: 'Import your YNAB register into the current book with payee and category mapping.',
                exportHint: (
                    <p>
                        In YNAB, open your budget and use{' '}
                        <span className="font-mono text-xs">Budget name → Export budget data</span>, unzip
                        the download, and upload the <span className="font-mono text-xs">…Register.csv</span>{' '}
                        file (columns: Account, Flag, Date, Payee, Category Group/Category, Memo, Outflow,
                        Inflow). Transfer rows import with their &quot;Transfer : …&quot; payee — map their
                        category as needed.
                    </p>
                ),
                dropHint: 'Drop the YNAB register CSV here or click to browse',
            }}
        />
    );
}
