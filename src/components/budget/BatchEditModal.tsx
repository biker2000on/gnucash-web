'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';

interface BatchEditModalProps {
    isOpen: boolean;
    onClose: () => void;
    budgetGuid: string;
    accountGuid: string;
    accountName: string;
    numPeriods: number;
    currentAverage?: number;
    onUpdate: () => void;
}

export function BatchEditModal({
    isOpen,
    onClose,
    budgetGuid,
    accountGuid,
    accountName,
    numPeriods,
    currentAverage,
    onUpdate
}: BatchEditModalProps) {
    const [amount, setAmount] = useState(currentAverage?.toString() || '');
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSave = async () => {
        const value = parseFloat(amount);
        if (isNaN(value)) {
            setError('Please enter a valid number');
            return;
        }

        setIsSaving(true);
        setError(null);

        try {
            const response = await fetch(`/api/budgets/${budgetGuid}/amounts/all-periods`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account_guid: accountGuid,
                    amount: value
                })
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Failed to update');
            }

            onUpdate();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setIsSaving(false);
        }
    };

    const handleClose = () => {
        setAmount(currentAverage?.toString() || '');
        setError(null);
        onClose();
    };

    return (
        <Modal isOpen={isOpen} onClose={handleClose} title="Set All Periods">
            <div className="space-y-4">
                <p className="text-neutral-300">
                    Set the same amount for all {numPeriods} periods of <strong className="text-neutral-100">{accountName}</strong>
                </p>

                <div>
                    <label htmlFor="amount" className="block text-sm font-medium text-neutral-300 mb-1">
                        Amount per period
                    </label>
                    <div className="relative">
                        <span className="absolute left-3 top-2 text-neutral-400">$</span>
                        <input
                            id="amount"
                            type="text"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="0.00"
                            className={`w-full pl-7 pr-3 py-2 bg-neutral-800 border rounded-md text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent ${
                                error ? 'border-rose-500' : 'border-neutral-700'
                            }`}
                            autoFocus
                        />
                    </div>
                    {error && (
                        <p className="mt-1 text-sm text-rose-400">{error}</p>
                    )}
                </div>

                {amount && !isNaN(parseFloat(amount)) && (
                    <div className="p-3 bg-cyan-900/30 border border-cyan-800/50 rounded-md text-sm text-cyan-300">
                        Total for all {numPeriods} periods: <strong className="text-cyan-200">${(parseFloat(amount) * numPeriods).toFixed(2)}</strong>
                    </div>
                )}

                <div className="flex justify-end gap-3">
                    <button
                        onClick={handleClose}
                        className="px-4 py-2 text-neutral-300 hover:bg-neutral-700 rounded-md transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving || !amount}
                        className="px-4 py-2 bg-cyan-600 text-white rounded-md hover:bg-cyan-500 transition-colors disabled:opacity-50"
                    >
                        {isSaving ? 'Saving...' : 'Apply to All Periods'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
