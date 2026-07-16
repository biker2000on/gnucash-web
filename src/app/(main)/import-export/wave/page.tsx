'use client';

import BusinessImportWizard from '@/components/import/BusinessImportWizard';

export default function WaveImportPage() {
    return (
        <BusinessImportWizard
            config={{
                source: 'wave',
                title: 'Import Wave Accounting',
                blurb: 'Rebuild a Wave business as a new book from its accounting exports — no connection required.',
                exportHint: (
                    <>
                        <p>
                            <span className="text-foreground font-medium">1. Transactions (required):</span>{' '}
                            In Wave go to{' '}
                            <span className="font-mono text-xs">Settings → Data export → Accounting Transactions (CSV)</span>{' '}
                            and download the export. Rows are grouped into balanced transactions by
                            Transaction ID (or by date and description when the export has no ID column).
                        </p>
                        <p>
                            <span className="text-foreground font-medium">2. Chart of Accounts (recommended):</span>{' '}
                            Export the Chart of Accounts CSV (Account Name, Account Type) so every account
                            gets its correct type; without it, types are inferred from account names.
                        </p>
                    </>
                ),
                journalLabel: 'Accounting Transactions CSV',
                journalDropHint: 'Drop the Wave transactions export here or click to browse',
                coaLabel: 'Chart of Accounts CSV (optional)',
                coaDropHint: 'Drop the Chart of Accounts export here or click to browse',
                defaultEntityType: 'sole_prop',
            }}
        />
    );
}
