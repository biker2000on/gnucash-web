'use client';

import { useState } from 'react';

const CONTENTS = [
    { name: 'Form 8949 CSV', detail: 'Realized sales in IRS column order, bucketed into boxes A–F with wash-sale adjustments' },
    { name: 'Schedule D CSV', detail: 'Short-term and long-term totals ready for Schedule D' },
    { name: 'Contribution summary CSV', detail: 'Retirement and HSA contributions per account with IRS limit usage' },
    { name: 'Schedule C CSV', detail: 'Sole-proprietor income and expense lines (included when the book has business activity)' },
    { name: 'Charitable giving CSV', detail: 'Donation detail for Schedule A, grouped by giving account, with $250+ acknowledgment flags' },
    { name: 'Withholding snapshot', detail: 'Projected federal liability vs withholding (supported tax years)' },
    { name: 'README.txt', detail: 'Manifest describing every file plus data caveats' },
];

export default function TaxPackagePage() {
    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: 6 }, (_, i) => currentYear - i);
    const [year, setYear] = useState(currentYear - 1);
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const download = async () => {
        setDownloading(true);
        setError(null);
        try {
            const res = await fetch(`/api/reports/tax-package?year=${year}`);
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                setError(body?.error ?? `Failed to generate package (${res.status})`);
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tax-package-${year}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch {
            setError('Failed to generate package');
        } finally {
            setDownloading(false);
        }
    };

    return (
        <div className="p-4 sm:p-6 max-w-3xl space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-foreground">Year-End Tax Package</h1>
                <p className="mt-1 text-sm text-foreground-muted">
                    One ZIP with everything your accountant asks for, generated straight from the book.
                </p>
            </div>

            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 space-y-4">
                <div className="flex flex-wrap items-end gap-4">
                    <label className="block">
                        <span className="text-xs uppercase tracking-wider text-foreground-tertiary">Tax year</span>
                        <select
                            value={year}
                            onChange={e => setYear(parseInt(e.target.value, 10))}
                            className="mt-1 block bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                        >
                            {years.map(y => (
                                <option key={y} value={y}>{y}</option>
                            ))}
                        </select>
                    </label>
                    <button
                        onClick={download}
                        disabled={downloading}
                        className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-opacity"
                    >
                        {downloading ? 'Generating…' : `Download ${year} package`}
                    </button>
                </div>
                {error && (
                    <div className="text-sm text-rose-400 border border-rose-500/30 bg-rose-500/10 rounded-lg px-3 py-2">
                        {error}
                    </div>
                )}
            </div>

            <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6">
                <h2 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider mb-4">
                    What&rsquo;s inside
                </h2>
                <ul className="space-y-3">
                    {CONTENTS.map(item => (
                        <li key={item.name} className="flex gap-3 text-sm">
                            <svg className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            <div>
                                <span className="text-foreground font-medium">{item.name}</span>
                                <span className="text-foreground-muted"> — {item.detail}</span>
                            </div>
                        </li>
                    ))}
                </ul>
                <p className="mt-4 text-xs text-foreground-tertiary">
                    Sections without data for the selected year are omitted and noted in the README.
                    Figures are estimates from your books — verify against official forms before filing.
                </p>
            </div>
        </div>
    );
}
