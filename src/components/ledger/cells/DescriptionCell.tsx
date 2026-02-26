'use client';
import { DescriptionAutocomplete } from '@/components/ui/DescriptionAutocomplete';
import { TransactionSuggestion } from '@/app/api/transactions/descriptions/route';

interface DescriptionCellProps {
    value: string;
    onChange: (value: string) => void;
    onSelectSuggestion?: (suggestion: TransactionSuggestion) => void;
}

export function DescriptionCell({ value, onChange, onSelectSuggestion }: DescriptionCellProps) {
    return (
        <DescriptionAutocomplete
            value={value}
            onChange={onChange}
            onSelectSuggestion={onSelectSuggestion}
            placeholder="Description..."
            className="text-sm"
        />
    );
}
