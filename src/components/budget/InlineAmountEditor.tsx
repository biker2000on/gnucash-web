'use client';

import { useState, useRef, useEffect } from 'react';
import { formatCurrency, applyBalanceReversal, BalanceReversal } from '@/lib/format';

interface InlineAmountEditorProps {
    value: number;
    budgetGuid: string;
    accountGuid: string;
    periodNum: number;
    currency?: string;
    accountType?: string;
    balanceReversal?: BalanceReversal;
    onUpdate: (newValue: number) => void;
}

export function InlineAmountEditor({
    value,
    budgetGuid,
    accountGuid,
    periodNum,
    currency = 'USD',
    accountType = 'EXPENSE',
    balanceReversal = 'none',
    onUpdate
}: InlineAmountEditorProps) {
    // Apply balance reversal for display purposes only
    const displayValue = applyBalanceReversal(value, accountType, balanceReversal);
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(value.toString());
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    useEffect(() => {
        setEditValue(value.toString());
    }, [value]);

    const handleClick = () => {
        if (!isSaving) {
            setIsEditing(true);
            setError(null);
        }
    };

    const handleSave = async () => {
        const newValue = parseFloat(editValue);
        if (isNaN(newValue)) {
            setError('Invalid number');
            return;
        }

        if (newValue === value) {
            setIsEditing(false);
            return;
        }

        setIsSaving(true);
        setError(null);

        try {
            const response = await fetch(`/api/budgets/${budgetGuid}/amounts`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account_guid: accountGuid,
                    period_num: periodNum,
                    amount: newValue
                })
            });

            if (!response.ok) {
                throw new Error('Failed to save');
            }

            onUpdate(newValue);
            setIsEditing(false);
        } catch (err) {
            setError('Save failed');
            setEditValue(value.toString());
        } finally {
            setIsSaving(false);
        }
    };

    const handleCancel = () => {
        setEditValue(value.toString());
        setIsEditing(false);
        setError(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSave();
        } else if (e.key === 'Escape') {
            handleCancel();
        }
    };

    if (isEditing) {
        return (
            <div className="relative">
                <input
                    ref={inputRef}
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleSave}
                    onKeyDown={handleKeyDown}
                    disabled={isSaving}
                    className={`w-full px-2 py-1 text-right text-sm border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                        error ? 'border-red-500' : 'border-blue-500'
                    } ${isSaving ? 'bg-gray-100' : 'bg-white'}`}
                />
                {error && (
                    <div className="absolute top-full right-0 mt-1 text-xs text-red-500 whitespace-nowrap">
                        {error}
                    </div>
                )}
            </div>
        );
    }

    return (
        <button
            onClick={handleClick}
            disabled={isSaving}
            className={`w-full text-right px-2 py-1 rounded hover:bg-surface-hover/50 transition-colors ${
                isSaving ? 'opacity-50' : ''
            } ${value === 0 ? 'text-foreground-muted' : displayValue < 0 ? 'text-rose-400' : 'text-foreground'}`}
            title="Click to edit"
        >
            {value === 0 ? '—' : formatCurrency(displayValue, currency)}
        </button>
    );
}
