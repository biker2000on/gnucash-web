'use client';

export type InvestmentTransactionType =
    | 'buy'
    | 'sell'
    | 'dividend'
    | 'stock_split'
    | 'return_of_capital'
    | 'reinvested_dividend'
    | 'realized_gain'
    | 'other';

interface TransactionTypeIconProps {
    type: InvestmentTransactionType;
    className?: string;
}

const TYPE_CONFIG: Record<InvestmentTransactionType, { icon: string; label: string; color: string }> = {
    buy:                   { icon: '↓', label: 'Buy',          color: 'text-positive' },
    sell:                  { icon: '↑', label: 'Sell',         color: 'text-negative' },
    dividend:              { icon: '$', label: 'Dividend',     color: 'text-warning' },
    stock_split:           { icon: '⇅', label: 'Split',       color: 'text-secondary' },
    return_of_capital:     { icon: '↩', label: 'ROC',         color: 'text-secondary' },
    reinvested_dividend:   { icon: '⟳', label: 'DRIP',        color: 'text-warning' },
    realized_gain:         { icon: '±', label: 'Realized G/L', color: 'text-primary' },
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
