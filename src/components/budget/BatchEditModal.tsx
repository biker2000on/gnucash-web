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
                <p className="text-gray-600">
                    Set the same amount for all {numPeriods} periods of <strong>{accountName}</strong>
                </p>

                <div>
                    <label htmlFor="amount" className="block text-sm font-medium text-gray-700 mb-1">
                        Amount per period
                    </label>
                    <div className="relative">
                        <span className="absolute left-3 top-2 text-gray-500">$</span>
                        <input
                            id="amount"
                            type="text"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="0.00"
                            className={`w-full pl-7 pr-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                                error ? 'border-red-500' : 'border-gray-300'
                            }`}
                            autoFocus
                        />
                    </div>
                    {error && (
                        <p className="mt-1 text-sm text-red-500">{error}</p>
                    )}
                </div>

                {amount && !isNaN(parseFloat(amount)) && (
                    <div className="p-3 bg-blue-50 rounded-md text-sm text-blue-700">
                        Total for all {numPeriods} periods: <strong>${(parseFloat(amount) * numPeriods).toFixed(2)}</strong>
                    </div>
                )}

                <div className="flex justify-end gap-3">
                    <button
                        onClick={handleClose}
                        className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving || !amount}
                        className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                        {isSaving ? 'Saving...' : 'Apply to All Periods'}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
