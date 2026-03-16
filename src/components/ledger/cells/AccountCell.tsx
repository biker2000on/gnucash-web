'use client';
import { AccountSelector } from '@/components/ui/AccountSelector';

interface AccountCellProps {
    value: string;
    onChange: (guid: string, name: string) => void;
    onEnter?: () => void;
    onArrowUp?: () => void;
    onArrowDown?: () => void;
    autoFocus?: boolean;
    onFocus?: () => void;
    onTab?: () => void;
}

export function AccountCell({ value, onChange, onEnter, onArrowUp, onArrowDown, autoFocus, onFocus, onTab }: AccountCellProps) {
    return (
        <AccountSelector
            value={value}
            onChange={(guid, name) => onChange(guid, name)}
            placeholder="Account..."
            compact
            onEnter={onEnter}
            onArrowUp={onArrowUp}
            onArrowDown={onArrowDown}
            autoFocus={autoFocus}
            onFocus={onFocus}
            onTab={onTab}
        />
    );
}
