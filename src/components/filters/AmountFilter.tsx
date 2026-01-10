'use client';

interface AmountFilterProps {
    minAmount: string;
    maxAmount: string;
    onMinChange: (value: string) => void;
    onMaxChange: (value: string) => void;
}

export function AmountFilter({ minAmount, maxAmount, onMinChange, onMaxChange }: AmountFilterProps) {
    return (
        <div>
            <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-2">
                Amount Range
            </label>
            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 text-sm">$</span>
                    <input
                        type="number"
                        placeholder="Min"
                        value={minAmount}
                        onChange={(e) => onMinChange(e.target.value)}
                        className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg pl-7 pr-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-cyan-500/50 placeholder:text-neutral-600"
                        min="0"
                        step="0.01"
                    />
                </div>
                <span className="text-neutral-600">—</span>
                <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 text-sm">$</span>
                    <input
                        type="number"
                        placeholder="Max"
                        value={maxAmount}
                        onChange={(e) => onMaxChange(e.target.value)}
                        className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg pl-7 pr-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-cyan-500/50 placeholder:text-neutral-600"
                        min="0"
                        step="0.01"
                    />
                </div>
            </div>
        </div>
    );
}
