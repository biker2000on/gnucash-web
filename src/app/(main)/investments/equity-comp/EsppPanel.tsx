'use client';

import { useMemo, useState } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { toLocalDateString } from '@/lib/datePresets';
import { formatCurrency } from '@/lib/format';
import {
    computeEsppSplits,
    validateEsppInput,
    esppPurchasePriceFromDiscount,
    EquityCompValidationError,
    type EquityCompSplitSpec,
} from '@/lib/equity-comp-core';
import { SplitPreviewTable } from './SplitPreviewTable';

const LABEL_CLASS = 'block text-xs text-foreground-muted uppercase tracking-wider mb-1';
const INPUT_CLASS =
    'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground ' +
    'placeholder-foreground-muted focus:outline-none focus:border-primary/50';
const MONO = { fontFeatureSettings: "'tnum'" } as const;

export function EsppPanel({ onPosted }: { onPosted: () => void }) {
    const [stockAccountGuid, setStockAccountGuid] = useState('');
    const [stockAccountName, setStockAccountName] = useState('');
    const [cashAccountGuid, setCashAccountGuid] = useState('');
    const [cashAccountName, setCashAccountName] = useState('');
    const [incomeAccountGuid, setIncomeAccountGuid] = useState('');
    const [incomeAccountName, setIncomeAccountName] = useState('');
    const [purchaseDate, setPurchaseDate] = useState(() => toLocalDateString(new Date()));
    const [shares, setShares] = useState('');
    const [fmvPerShare, setFmvPerShare] = useState('');
    const [discountPercent, setDiscountPercent] = useState('15');
    const [purchasePrice, setPurchasePrice] = useState('');
    const [priceEdited, setPriceEdited] = useState(false);
    const [description, setDescription] = useState('');
    const [posting, setPosting] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);
    const [success, setSuccess] = useState<string | null>(null);

    // Purchase price derives from FMV × (1 − discount) until the user types a
    // custom price; editing the discount reverts to the derived price.
    const derivePrice = (fmvStr: string, discountStr: string): string => {
        const fmv = parseFloat(fmvStr);
        const discount = parseFloat(discountStr);
        if (!Number.isFinite(fmv) || fmv <= 0) return '';
        const d = Number.isFinite(discount) ? discount : 0;
        if (d < 0 || d >= 100) return '';
        return esppPurchasePriceFromDiscount(fmv, d).toFixed(4).replace(/\.?0+$/, '');
    };

    const handleFmvChange = (value: string) => {
        setFmvPerShare(value);
        if (!priceEdited) setPurchasePrice(derivePrice(value, discountPercent));
    };

    const handleDiscountChange = (value: string) => {
        setDiscountPercent(value);
        setPriceEdited(false);
        setPurchasePrice(derivePrice(fmvPerShare, value));
    };

    const handlePriceChange = (value: string) => {
        setPurchasePrice(value);
        setPriceEdited(true);
    };

    const numericInput = useMemo(() => ({
        shares: parseFloat(shares),
        fmvPerShare: parseFloat(fmvPerShare),
        purchasePricePerShare: parseFloat(purchasePrice),
    }), [shares, fmvPerShare, purchasePrice]);

    const hasNumericInput =
        shares.trim() !== '' && fmvPerShare.trim() !== '' && purchasePrice.trim() !== '';

    const preview = useMemo((): { specs: EquityCompSplitSpec[]; problems: string[] } => {
        if (!hasNumericInput) return { specs: [], problems: [] };
        try {
            return { specs: computeEsppSplits(numericInput), problems: [] };
        } catch (err) {
            if (err instanceof EquityCompValidationError) {
                return { specs: [], problems: err.errors };
            }
            return { specs: [], problems: ['Invalid input'] };
        }
    }, [hasNumericInput, numericInput]);

    const discountValue = hasNumericInput && preview.problems.length === 0
        ? (numericInput.fmvPerShare - numericInput.purchasePricePerShare) * numericInput.shares
        : null;

    const handlePost = async () => {
        setErrors([]);
        setSuccess(null);

        const problems: string[] = [];
        if (!stockAccountGuid) problems.push('Stock account is required');
        if (!cashAccountGuid) problems.push('Cash account is required');
        if (!incomeAccountGuid) problems.push('Compensation income account is required');
        if (!purchaseDate) problems.push('Purchase date is required');
        problems.push(...validateEsppInput(numericInput));
        if (problems.length > 0) {
            setErrors(problems);
            return;
        }

        setPosting(true);
        try {
            const res = await fetch('/api/equity-comp/espp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stockAccountGuid,
                    purchaseDate,
                    shares: numericInput.shares,
                    fmvPerShare: numericInput.fmvPerShare,
                    discountPercent: parseFloat(discountPercent) || undefined,
                    purchasePricePerShare: numericInput.purchasePricePerShare,
                    cashAccountGuid,
                    incomeAccountGuid,
                    description: description.trim() || undefined,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setErrors(data.errors ?? [data.error ?? 'Failed to post ESPP purchase']);
                return;
            }
            setSuccess(`Posted: ${data.description}`);
            setShares('');
            setFmvPerShare('');
            setPurchasePrice('');
            setPriceEdited(false);
            setDescription('');
            onPosted();
        } catch {
            setErrors(['Network error while posting ESPP purchase']);
        } finally {
            setPosting(false);
        }
    };

    return (
        <div className="bg-surface border border-border rounded-lg p-4 sm:p-6 space-y-4">
            <div className="pb-3 border-b border-border">
                <h2 className="text-base font-semibold text-foreground">ESPP Purchase</h2>
                <p className="text-xs text-foreground-secondary mt-0.5">
                    Shares enter at FMV cost basis; the discount is booked as compensation
                    income and cash is reduced by only the actual purchase cost.
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
                    <label className={LABEL_CLASS}>Purchase Date</label>
                    <input
                        type="date"
                        value={purchaseDate}
                        onChange={e => setPurchaseDate(e.target.value)}
                        className={`${INPUT_CLASS} font-mono`}
                    />
                </div>
                <div>
                    <label className={LABEL_CLASS}>Shares Purchased</label>
                    <input
                        type="number"
                        step="any"
                        min="0"
                        value={shares}
                        onChange={e => setShares(e.target.value)}
                        placeholder="0"
                        className={`${INPUT_CLASS} font-mono`}
                    />
                </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
                <div>
                    <label className={LABEL_CLASS}>FMV per Share</label>
                    <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={fmvPerShare}
                        onChange={e => handleFmvChange(e.target.value)}
                        placeholder="0.00"
                        className={`${INPUT_CLASS} font-mono`}
                    />
                </div>
                <div>
                    <label className={LABEL_CLASS}>Discount %</label>
                    <input
                        type="number"
                        step="0.5"
                        min="0"
                        max="99"
                        value={discountPercent}
                        onChange={e => handleDiscountChange(e.target.value)}
                        placeholder="15"
                        className={`${INPUT_CLASS} font-mono`}
                    />
                </div>
                <div>
                    <label className={`${LABEL_CLASS} ${priceEdited ? 'text-primary' : ''}`}>
                        Price Paid {priceEdited ? '(custom)' : '(auto)'}
                    </label>
                    <input
                        type="number"
                        step="0.0001"
                        min="0"
                        value={purchasePrice}
                        onChange={e => handlePriceChange(e.target.value)}
                        placeholder="0.00"
                        className={`${INPUT_CLASS} font-mono ${priceEdited ? 'border-primary/30' : ''}`}
                    />
                </div>
            </div>

            <div>
                <label className={LABEL_CLASS}>Cash Account (payroll deductions / brokerage cash)</label>
                <AccountSelector
                    value={cashAccountGuid}
                    onChange={(guid, name) => { setCashAccountGuid(guid); setCashAccountName(name); }}
                    placeholder="Select cash account..."
                    accountTypes={['BANK', 'ASSET', 'CASH']}
                />
            </div>

            <div>
                <label className={LABEL_CLASS}>Compensation Income Account (discount)</label>
                <AccountSelector
                    value={incomeAccountGuid}
                    onChange={(guid, name) => { setIncomeAccountGuid(guid); setIncomeAccountName(name); }}
                    placeholder="Select income account..."
                    accountTypes={['INCOME']}
                />
            </div>

            <div>
                <label className={LABEL_CLASS}>Description (optional)</label>
                <input
                    type="text"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="ESPP Purchase..."
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
                        {discountValue !== null && (
                            <span className="text-xs text-foreground-secondary font-mono" style={MONO}>
                                Discount income: {formatCurrency(discountValue)}
                            </span>
                        )}
                    </div>
                    <SplitPreviewTable
                        specs={preview.specs}
                        labels={{
                            accountNames: {
                                stock: stockAccountName,
                                cash: cashAccountName,
                                income: incomeAccountName,
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
                        'Record Purchase'
                    )}
                </button>
            </div>
        </div>
    );
}
