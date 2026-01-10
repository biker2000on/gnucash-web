'use client';

import { SplitFormData } from '@/lib/types';
import { AccountSelector } from './ui/AccountSelector';

interface SplitRowProps {
    split: SplitFormData;
    index: number;
    onChange: (index: number, field: keyof SplitFormData, value: string) => void;
    onRemove: (index: number) => void;
    canRemove: boolean;
}

export function SplitRow({
    split,
    index,
    onChange,
    onRemove,
    canRemove,
}: SplitRowProps) {
    const handleAccountChange = (accountGuid: string, accountName: string) => {
        onChange(index, 'account_guid', accountGuid);
        onChange(index, 'account_name', accountName);
    };

    const handleDebitChange = (value: string) => {
        // Clear credit when entering debit
        onChange(index, 'debit', value);
        if (value) {
            onChange(index, 'credit', '');
        }
    };

    const handleCreditChange = (value: string) => {
        // Clear debit when entering credit
        onChange(index, 'credit', value);
        if (value) {
            onChange(index, 'debit', '');
        }
    };

    return (
        <div className="grid grid-cols-12 gap-2 items-center py-2 border-b border-neutral-800 last:border-0">
            {/* Account Selector */}
            <div className="col-span-5">
                <AccountSelector
                    value={split.account_guid}
                    onChange={handleAccountChange}
                    placeholder="Select account..."
                />
            </div>

            {/* Debit */}
            <div className="col-span-2">
                <input
                    type="number"
                    step="0.01"
                    placeholder="Debit"
                    value={split.debit}
                    onChange={(e) => handleDebitChange(e.target.value)}
                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-emerald-400 placeholder-neutral-600 focus:outline-none focus:border-cyan-500/50 text-right font-mono"
                />
            </div>

            {/* Credit */}
            <div className="col-span-2">
                <input
                    type="number"
                    step="0.01"
                    placeholder="Credit"
                    value={split.credit}
                    onChange={(e) => handleCreditChange(e.target.value)}
                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-rose-400 placeholder-neutral-600 focus:outline-none focus:border-cyan-500/50 text-right font-mono"
                />
            </div>

            {/* Memo */}
            <div className="col-span-2">
                <input
                    type="text"
                    placeholder="Memo"
                    value={split.memo}
                    onChange={(e) => onChange(index, 'memo', e.target.value)}
                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-cyan-500/50"
                />
            </div>

            {/* Remove Button */}
            <div className="col-span-1 flex justify-center">
                {canRemove && (
                    <button
                        type="button"
                        onClick={() => onRemove(index)}
                        className="p-2 text-neutral-500 hover:text-rose-400 transition-colors"
                        title="Remove split"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
}
