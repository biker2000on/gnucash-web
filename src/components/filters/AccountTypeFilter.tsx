'use client';

// GnuCash account types
export const ACCOUNT_TYPES = [
    { value: 'ASSET', label: 'Asset', color: 'emerald' },
    { value: 'BANK', label: 'Bank', color: 'emerald' },
    { value: 'CASH', label: 'Cash', color: 'emerald' },
    { value: 'CREDIT', label: 'Credit Card', color: 'rose' },
    { value: 'LIABILITY', label: 'Liability', color: 'rose' },
    { value: 'INCOME', label: 'Income', color: 'cyan' },
    { value: 'EXPENSE', label: 'Expense', color: 'orange' },
    { value: 'EQUITY', label: 'Equity', color: 'purple' },
    { value: 'STOCK', label: 'Stock', color: 'amber' },
    { value: 'MUTUAL', label: 'Mutual Fund', color: 'amber' },
    { value: 'RECEIVABLE', label: 'Receivable', color: 'emerald' },
    { value: 'PAYABLE', label: 'Payable', color: 'rose' },
] as const;

interface AccountTypeFilterProps {
    selectedTypes: string[];
    onChange: (types: string[]) => void;
}

export function AccountTypeFilter({ selectedTypes, onChange }: AccountTypeFilterProps) {
    const toggleType = (type: string) => {
        if (selectedTypes.includes(type)) {
            onChange(selectedTypes.filter(t => t !== type));
        } else {
            onChange([...selectedTypes, type]);
        }
    };

    const colorClasses: Record<string, string> = {
        emerald: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400',
        rose: 'bg-rose-500/20 border-rose-500/50 text-rose-400',
        cyan: 'bg-cyan-500/20 border-cyan-500/50 text-cyan-400',
        orange: 'bg-orange-500/20 border-orange-500/50 text-orange-400',
        purple: 'bg-purple-500/20 border-purple-500/50 text-purple-400',
        amber: 'bg-amber-500/20 border-amber-500/50 text-amber-400',
    };

    return (
        <div>
            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
                Account Types
            </label>
            <div className="flex flex-wrap gap-1.5">
                {ACCOUNT_TYPES.map(type => {
                    const isSelected = selectedTypes.includes(type.value);
                    return (
                        <button
                            key={type.value}
                            onClick={() => toggleType(type.value)}
                            className={`px-2 py-1 text-xs rounded-lg border transition-all ${
                                isSelected
                                    ? colorClasses[type.color]
                                    : 'bg-background-tertiary/50 border-border-hover text-foreground-secondary hover:border-border-hover'
                            }`}
                        >
                            {type.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
