'use client';
import { AccountSelector } from '@/components/ui/AccountSelector';

interface AccountCellProps {
    value: string;
    onChange: (guid: string) => void;
}

export function AccountCell({ value, onChange }: AccountCellProps) {
    return (
        <AccountSelector
            value={value}
            onChange={(guid) => onChange(guid)}
            placeholder="Account..."
        />
    );
}
