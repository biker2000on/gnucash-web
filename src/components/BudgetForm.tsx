'use client';

import { useState } from 'react';

interface BudgetFormData {
    name: string;
    description: string;
    num_periods: number;
    recurrence_period_type?: string;
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
        recurrence_period_type: initialData?.recurrence_period_type,
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
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Budget Name <span className="text-rose-400">*</span>
                </label>
                <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-cyan-500/50 transition-all"
                    placeholder="e.g., 2024 Annual Budget"
                />
            </div>

            {/* Description */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Description
                </label>
                <textarea
                    value={formData.description}
                    onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    rows={3}
                    className="w-full bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-cyan-500/50 transition-all resize-none"
                    placeholder="Optional description..."
                />
            </div>

            {/* Period Settings */}
            <div>
                <label className="block text-sm font-medium text-foreground-secondary mb-2">
                    Period Settings
                </label>
                {mode === 'edit' && (
                    <p className="mb-2 text-xs text-amber-400">
                        Period settings are read-only after creation.
                    </p>
                )}
                <div className="flex items-center gap-4">
                    <div>
                        <span className="text-xs text-foreground-muted block mb-1">Number of Periods</span>
                        <input
                            type="number"
                            min={1}
                            max={60}
                            value={formData.num_periods}
                            disabled={mode === 'edit'}
                            onChange={e => setFormData(prev => ({
                                ...prev,
                                num_periods: Math.max(1, Math.min(60, parseInt(e.target.value) || 12))
                            }))}
                            className="w-24 bg-input-bg border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-cyan-500/50 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                    </div>
                    {mode === 'edit' && formData.recurrence_period_type && (
                        <div>
                            <span className="text-xs text-foreground-muted block mb-1">Period Length</span>
                            <span className="text-foreground px-4 py-3 inline-block">
                                {formData.recurrence_period_type === 'month' ? 'Monthly' :
                                 formData.recurrence_period_type === 'year' ? 'Yearly' :
                                 formData.recurrence_period_type}
                            </span>
                        </div>
                    )}
                    {mode === 'create' && (
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setFormData(prev => ({ ...prev, num_periods: 12 }))}
                                className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                                    formData.num_periods === 12
                                        ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                        : 'bg-background-tertiary text-foreground-secondary hover:text-foreground'
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
                                        : 'bg-background-tertiary text-foreground-secondary hover:text-foreground'
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
                                        : 'bg-background-tertiary text-foreground-secondary hover:text-foreground'
                                }`}
                            >
                                Yearly (1)
                            </button>
                        </div>
                    )}
                </div>
                <p className="mt-2 text-xs text-foreground-muted">
                    {mode === 'create'
                        ? 'The number of budget periods. Cannot be changed after creation.'
                        : `This budget has ${formData.num_periods} ${formData.recurrence_period_type || ''} period${formData.num_periods !== 1 ? 's' : ''}.`}
                </p>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4 border-t border-border">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
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
