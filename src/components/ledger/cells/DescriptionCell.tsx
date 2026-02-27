'use client';
import { DescriptionAutocomplete } from '@/components/ui/DescriptionAutocomplete';
import { TransactionSuggestion } from '@/app/api/transactions/descriptions/route';

interface DescriptionCellProps {
    value: string;
    onChange: (value: string) => void;
    onSelectSuggestion?: (suggestion: TransactionSuggestion) => void;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    autoFocus?: boolean;
    onFocus?: () => void;
}

export function DescriptionCell({ value, onChange, onSelectSuggestion, onEnter, onArrowUp, onArrowDown, autoFocus, onFocus }: DescriptionCellProps) {
    return (
        <DescriptionAutocomplete
            value={value}
            onChange={onChange}
            onSelectSuggestion={onSelectSuggestion}
            placeholder="Description..."
            className="text-sm"
            onEnter={onEnter}
            onArrowUp={onArrowUp}
            onArrowDown={onArrowDown}
            autoFocus={autoFocus}
            onFocus={onFocus}
        />
    );
}
