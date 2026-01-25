'use client';

import { useState } from 'react';

interface BudgetFormData {
    name: string;
    description: string;
    num_periods: number;
}

interface BudgetFormProps {
    mode: 'create' | 'edit';
    initialData?: Partial<BudgetFormData>;
    onSave: (data: BudgetFormData) => Promise<void>;
    onCancel: () => void;
}

export function BudgetForm({ mode, initialData, onSave, onCancel }: BudgetFormProps) {
    const [formData, setFormData] = useState<BudgetFormData>({
        name: initialData?.name || '',
        description: initialData?.description || '',
        num_periods: initialData?.num_periods || 12,
    });

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSaving(true);

        try {
            await onSave(formData);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save budget');
        } finally {
            setSaving(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-rose-400 text-sm">
                    {error}
                </div>
            )}

            {/* Name */}
            <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                    Budget Name <span className="text-rose-400">*</span>
                </label>
                <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-cyan-500/50 transition-all"
                    placeholder="e.g., 2024 Annual Budget"
                />
            </div>

            {/* Description */}
            <div>
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                    Description
                </label>
                <textarea
                    value={formData.description}
                    onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-cyan-500/50 transition-all resize-none"
                    placeholder="Optional description..."
                />
            </div>

            {/* Number of Periods - only for create mode */}
            {mode === 'create' && (
                <div>
                    <label className="block text-sm font-medium text-neutral-300 mb-2">
                        Number of Periods
                    </label>
                    <div className="flex items-center gap-4">
                        <input
                            type="number"
                            min={1}
                            max={60}
                            value={formData.num_periods}
                            onChange={e => setFormData(prev => ({
                                ...prev,
                                num_periods: Math.max(1, Math.min(60, parseInt(e.target.value) || 12))
                            }))}
                            className="w-24 bg-neutral-950/50 border border-neutral-800 rounded-xl px-4 py-3 text-neutral-200 focus:outline-none focus:border-cyan-500/50 transition-all"
                        />
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setFormData(prev => ({ ...prev, num_periods: 12 }))}
                                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                                    formData.num_periods === 12
                                        ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                        : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                                }`}
                            >
                                Monthly (12)
                            </button>
                            <button
                                type="button"
                                onClick={() => setFormData(prev => ({ ...prev, num_periods: 4 }))}
                                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                                    formData.num_periods === 4
                                        ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                        : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                                }`}
                            >
                                Quarterly (4)
                            </button>
                            <button
                                type="button"
                                onClick={() => setFormData(prev => ({ ...prev, num_periods: 1 }))}
                                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                                    formData.num_periods === 1
                                        ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                        : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                                }`}
                            >
                                Yearly (1)
                            </button>
                        </div>
                    </div>
                    <p className="mt-2 text-xs text-neutral-500">
                        The number of budget periods. Cannot be changed after creation.
                    </p>
                </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4 border-t border-neutral-800">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={saving || !formData.name}
                    className="px-6 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                >
                    {saving ? 'Saving...' : mode === 'create' ? 'Create Budget' : 'Save Changes'}
                </button>
            </div>
        </form>
    );
}
