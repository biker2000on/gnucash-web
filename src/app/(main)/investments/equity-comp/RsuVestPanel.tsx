'use client';

import { useMemo, useState } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { toLocalDateString } from '@/lib/datePresets';
import { formatCurrency } from '@/lib/format';
import {
    computeVestSplits,
    validateVestInput,
    EquityCompValidationError,
    type EquityCompSplitSpec,
} from '@/lib/equity-comp-core';
import { SplitPreviewTable } from './SplitPreviewTable';

const LABEL_CLASS = 'block text-xs text-foreground-muted uppercase tracking-wider mb-1';
const INPUT_CLASS =
    'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground ' +
    'placeholder-foreground-muted focus:outline-none focus:border-primary/50';
const MONO = { fontFeatureSettings: "'tnum'" } as const;

export function RsuVestPanel({ onPosted }: { onPosted: () => void }) {
    const [stockAccountGuid, setStockAccountGuid] = useState('');
    const [stockAccountName, setStockAccountName] = useState('');
    const [incomeAccountGuid, setIncomeAccountGuid] = useState('');
    const [incomeAccountName, setIncomeAccountName] = useState('');
    const [taxAccountGuid, setTaxAccountGuid] = useState('');
    const [taxAccountName, setTaxAccountName] = useState('');
    const [vestDate, setVestDate] = useState(() => toLocalDateString(new Date()));
    const [sharesVested, setSharesVested] = useState('');
    const [fmvPerShare, setFmvPerShare] = useState('');
    const [sharesWithheld, setSharesWithheld] = useState('');
    const [description, setDescription] = useState('');
    const [posting, setPosting] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [success, setSuccess] = useState<string | null>(null);

    const numericInput = useMemo(() => ({
        sharesVested: parseFloat(sharesVested),
        fmvPerShare: parseFloat(fmvPerShare),
        sharesWithheldForTax: sharesWithheld.trim() === '' ? 0 : parseFloat(sharesWithheld),
    }), [sharesVested, fmvPerShare, sharesWithheld]);

    const hasNumericInput = sharesVested.trim() !== '' && fmvPerShare.trim() !== '';

    // Live split preview from the shared pure computation core.
    const preview = useMemo((): { specs: EquityCompSplitSpec[]; problems: string[] } => {
        if (!hasNumericInput) return { specs: [], problems: [] };
        try {
            return { specs: computeVestSplits(numericInput), problems: [] };
        } catch (err) {
            if (err instanceof EquityCompValidationError) {
                return { specs: [], problems: err.errors };
            }
            return { specs: [], problems: ['Invalid input'] };
        }
    }, [hasNumericInput, numericInput]);

    const grossValue = hasNumericInput && preview.problems.length === 0
        ? numericInput.sharesVested * numericInput.fmvPerShare
        : null;

    const handlePost = async () => {
        setErrors([]);
        setSuccess(null);

        const problems: string[] = [];
        if (!stockAccountGuid) problems.push('Stock account is required');
        if (!incomeAccountGuid) problems.push('Compensation income account is required');
        if (!taxAccountGuid) problems.push('Tax withholding account is required');
        if (!vestDate) problems.push('Vest date is required');
        problems.push(...validateVestInput(numericInput));
        if (problems.length > 0) {
            setErrors(problems);
            return;
        }

        setPosting(true);
        try {
            const res = await fetch('/api/equity-comp/vest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stockAccountGuid,
                    vestDate,
                    sharesVested: numericInput.sharesVested,
                    fmvPerShare: numericInput.fmvPerShare,
                    sharesWithheldForTax: numericInput.sharesWithheldForTax,
                    incomeAccountGuid,
                    taxExpenseOrWithholdingAccountGuid: taxAccountGuid,
                    description: description.trim() || undefined,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setErrors(data.errors ?? [data.error ?? 'Failed to post vest event']);
                return;
            }
            setSuccess(`Posted: ${data.description}`);
            setSharesVested('');
            setFmvPerShare('');
            setSharesWithheld('');
            setDescription('');
            onPosted();
        } catch {
            setErrors(['Network error while posting vest event']);
        } finally {
            setPosting(false);
        }
    };

    return (
        <div className="bg-surface border border-border rounded-lg p-4 sm:p-6 space-y-4">
            <div className="pb-3 border-b border-border">
                <h2 className="text-base font-semibold text-foreground">RSU Vest</h2>
                <p className="text-xs text-foreground-secondary mt-0.5">
                    Net shares enter at FMV cost basis; gross vest value is booked as W-2
                    compensation income, withheld shares as tax paid.
                </p>
            </div>

            {errors.length > 0 && (
                <div className="bg-error/10 border border-error/30 rounded-lg p-3">
                    <ul className="list-disc list-inside text-sm text-error space-y-0.5">
                        {errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                </div>
            )}
            {success && (
                <div className="bg-success/10 border border-success/30 rounded-lg p-3 text-sm text-success">
                    {success}
                </div>
            )}

            <div>
                <label className={LABEL_CLASS}>Stock Account</label>
                <AccountSelector
                    value={stockAccountGuid}
                    onChange={(guid, name) => { setStockAccountGuid(guid); setStockAccountName(name); }}
                    placeholder="Select stock account..."
                    accountTypes={['STOCK', 'MUTUAL']}
                />
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className={LABEL_CLASS}>Vest Date</label>
                    <input
                        type="date"
                        value={vestDate}
                        onChange={e => setVestDate(e.target.value)}
                        className={`${INPUT_CLASS} font-mono`}
                    />
                </div>
                <div>
                    <label className={LABEL_CLASS}>FMV per Share</label>
                    <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={fmvPerShare}
                        onChange={e => setFmvPerShare(e.target.value)}
                        placeholder="0.00"
                        className={`${INPUT_CLASS} font-mono`}
                    />
                </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className={LABEL_CLASS}>Shares Vested (gross)</label>
                    <input
                        type="number"
                        step="any"
                        min="0"
                        value={sharesVested}
                        onChange={e => setSharesVested(e.target.value)}
                        placeholder="0"
                        className={`${INPUT_CLASS} font-mono`}
                    />
                </div>
                <div>
                    <label className={LABEL_CLASS}>Shares Withheld (sell-to-cover)</label>
                    <input
                        type="number"
                        step="any"
                        min="0"
                        value={sharesWithheld}
                        onChange={e => setSharesWithheld(e.target.value)}
                        placeholder="0"
                        className={`${INPUT_CLASS} font-mono`}
                    />
                </div>
            </div>

            <div>
                <label className={LABEL_CLASS}>Compensation Income Account (W-2)</label>
                <AccountSelector
                    value={incomeAccountGuid}
                    onChange={(guid, name) => { setIncomeAccountGuid(guid); setIncomeAccountName(name); }}
                    placeholder="Select income account..."
                    accountTypes={['INCOME']}
                />
            </div>

            <div>
                <label className={LABEL_CLASS}>Tax Withholding Account</label>
                <AccountSelector
                    value={taxAccountGuid}
                    onChange={(guid, name) => { setTaxAccountGuid(guid); setTaxAccountName(name); }}
                    placeholder="Select tax/withholding account..."
                    accountTypes={['EXPENSE', 'LIABILITY', 'ASSET']}
                />
            </div>

            <div>
                <label className={LABEL_CLASS}>Description (optional)</label>
                <input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="RSU Vest..."
                    className={INPUT_CLASS}
                />
            </div>

            {preview.problems.length > 0 && (
                <div className="text-xs text-warning">{preview.problems.join('; ')}</div>
            )}

            {preview.specs.length > 0 && (
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-foreground-muted uppercase tracking-wider">Preview</span>
                        {grossValue !== null && (
                            <span className="text-xs text-foreground-secondary font-mono" style={MONO}>
                                Gross vest value: {formatCurrency(grossValue)}
                            </span>
                        )}
                    </div>
                    <SplitPreviewTable
                        specs={preview.specs}
                        labels={{
                            accountNames: {
                                stock: stockAccountName,
                                income: incomeAccountName,
                                tax: taxAccountName,
                            },
                        }}
                    />
                </div>
            )}

            <div className="flex justify-end pt-2 border-t border-border">
                <button
                    type="button"
                    onClick={handlePost}
                    disabled={posting || preview.specs.length === 0}
                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
                >
                    {posting ? (
                        <>
                            <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                            Posting...
                        </>
                    ) : (
                        'Record Vest'
                    )}
                </button>
            </div>
        </div>
    );
}
