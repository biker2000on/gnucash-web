'use client';
import { DescriptionAutocomplete } from '@/components/ui/DescriptionAutocomplete';
import { TransactionSuggestion } from '@/app/api/transactions/descriptions/route';

interface DescriptionCellProps {
    value: string;
    onChange: (value: string) => void;
    onSelectSuggestion?: (suggestion: TransactionSuggestion) => void;
    onEnter?: () => void;
    onTab?: () => void;
    onShiftTab?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    autoFocus?: boolean;
    onFocus?: () => void;
    /** Scope description suggestions to transactions touching this account. */
    accountGuid?: string;
}

export function DescriptionCell({ value, onChange, onSelectSuggestion, onEnter, onTab, onShiftTab, onArrowUp, onArrowDown, autoFocus, onFocus, accountGuid }: DescriptionCellProps) {
    return (
        <DescriptionAutocomplete
            value={value}
            onChange={onChange}
            onSelectSuggestion={onSelectSuggestion}
            accountGuid={accountGuid}
            placeholder="Description..."
            className="text-xs"
            compact
            onEnter={onEnter}
            onTab={onTab}
            onShiftTab={onShiftTab}
            onArrowUp={onArrowUp}
            onArrowDown={onArrowDown}
            autoFocus={autoFocus}
            onFocus={onFocus}
        />
    );
}
