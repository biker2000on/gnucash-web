'use client';

import { Tooltip } from '@/components/ui/Tooltip';
import { getGlossaryEntry } from '@/lib/glossary';

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

const TYPE_CONFIG: Record<InvestmentTransactionType, { icon: string; label: string; color: string; term?: string }> = {
    buy:                   { icon: '↓', label: 'Buy',          color: 'text-positive' },
    sell:                  { icon: '↑', label: 'Sell',         color: 'text-negative' },
    dividend:              { icon: '$', label: 'Dividend',     color: 'text-warning' },
    stock_split:           { icon: '⇅', label: 'Split',       color: 'text-secondary' },
    return_of_capital:     { icon: '↩', label: 'ROC',         color: 'text-secondary', term: 'ROC' },
    reinvested_dividend:   { icon: '⟳', label: 'DRIP',        color: 'text-warning', term: 'DRIP' },
    realized_gain:         { icon: '±', label: 'Realized G/L', color: 'text-primary', term: 'G/L' },
    other:                 { icon: '·', label: 'Other',        color: 'text-foreground-muted' },
};

export default function TransactionTypeIcon({ type, className = '' }: TransactionTypeIconProps) {
    const config = TYPE_CONFIG[type] || TYPE_CONFIG.other;
    const entry = config.term ? getGlossaryEntry(config.term) : undefined;

    return (
        <Tooltip
            ariaLabel={entry ? `${config.label}: ${entry.expansion}` : config.label}
            content={
                entry ? (
                    <span className="block">
                        <span className="block font-medium text-foreground">
                            {config.label} — {entry.expansion}
                        </span>
                        {entry.gloss && <span className="mt-1 block text-foreground-secondary">{entry.gloss}</span>}
                    </span>
                ) : (
                    config.label
                )
            }
        >
            <span
                className={`inline-flex items-center justify-center w-5 h-5 rounded text-xs font-bold ${config.color} bg-background-secondary/50 ${className}`}
            >
                {config.icon}
            </span>
        </Tooltip>
    );
}
