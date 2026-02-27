'use client';
import { AccountSelector } from '@/components/ui/AccountSelector';

interface AccountCellProps {
    value: string;
    onChange: (guid: string) => void;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    autoFocus?: boolean;
    onFocus?: () => void;
}

export function AccountCell({ value, onChange, onEnter, onArrowUp, onArrowDown, autoFocus, onFocus }: AccountCellProps) {
    return (
        <AccountSelector
            value={value}
            onChange={(guid) => onChange(guid)}
            placeholder="Account..."
            onEnter={onEnter}
            onArrowUp={onArrowUp}
            onArrowDown={onArrowDown}
            autoFocus={autoFocus}
            onFocus={onFocus}
        />
    );
}
