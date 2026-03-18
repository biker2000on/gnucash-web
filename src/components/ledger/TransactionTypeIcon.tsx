'use client';

export type InvestmentTransactionType =
    | 'buy'
    | 'sell'
    | 'dividend'
    | 'stock_split'
    | 'return_of_capital'
    | 'reinvested_dividend'
    | 'other';

interface TransactionTypeIconProps {
    type: InvestmentTransactionType;
    className?: string;
}

const TYPE_CONFIG: Record<InvestmentTransactionType, { icon: string; label: string; color: string }> = {
    buy:                   { icon: '↓', label: 'Buy',          color: 'text-emerald-400' },
    sell:                  { icon: '↑', label: 'Sell',         color: 'text-rose-400' },
    dividend:              { icon: '$', label: 'Dividend',     color: 'text-amber-400' },
    stock_split:           { icon: '⇅', label: 'Split',       color: 'text-blue-400' },
    return_of_capital:     { icon: '↩', label: 'ROC',         color: 'text-purple-400' },
    reinvested_dividend:   { icon: '⟳', label: 'DRIP',        color: 'text-amber-400' },
    other:                 { icon: '·', label: 'Other',        color: 'text-foreground-muted' },
};

export default function TransactionTypeIcon({ type, className = '' }: TransactionTypeIconProps) {
    const config = TYPE_CONFIG[type] || TYPE_CONFIG.other;

    return (
        <span
            className={`inline-flex items-center justify-center w-5 h-5 rounded text-xs font-bold ${config.color} bg-background-secondary/50 ${className}`}
            title={config.label}
        >
            {config.icon}
        </span>
    );
}
