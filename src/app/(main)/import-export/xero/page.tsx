'use client';

import BusinessImportWizard from '@/components/import/BusinessImportWizard';

export default function XeroImportPage() {
    return (
        <BusinessImportWizard
            config={{
                source: 'xero',
                title: 'Import Xero',
                blurb: 'Rebuild a Xero organisation as a new book from its journal and chart of accounts exports.',
                exportHint: (
                    <>
                        <p>
                            <span className="text-foreground font-medium">1. Journal report (required):</span>{' '}
                            In Xero go to{' '}
                            <span className="font-mono text-xs">Accounting → Reports → Journal report</span>,
                            set the date range to cover the full history you want to migrate, then export
                            it as CSV (columns like Date, Source, Description, Reference, Account, Debit, Credit).
                        </p>
                        <p>
                            <span className="text-foreground font-medium">2. Chart of Accounts (recommended):</span>{' '}
                            Go to <span className="font-mono text-xs">Accounting → Chart of accounts → Export</span>{' '}
                            for the CSV (Code, Name, Type). Xero types (BANK, CURRENT, CURRLIAB, EQUITY,
                            REVENUE, EXPENSE, ...) map to GnuCash account types automatically.
                        </p>
                    </>
                ),
                journalLabel: 'Journal report CSV',
                journalDropHint: 'Drop the Xero Journal report export here or click to browse',
                coaLabel: 'Chart of Accounts CSV (optional)',
                coaDropHint: 'Drop the Chart of Accounts export here or click to browse',
                defaultEntityType: 'c_corp',
            }}
        />
    );
}
