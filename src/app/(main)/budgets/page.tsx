'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BudgetList } from '@/components/BudgetList';
import { BudgetForm } from '@/components/BudgetForm';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';

interface Budget {
    guid: string;
    name: string;
    description: string | null;
    num_periods: number;
    recurrence?: {
        period_type: string;
        mult: number;
        period_start: string;
    } | null;
    _count?: {
        amounts: number;
    };
}

const SCENARIO_PRESETS = [
    { label: 'Lean −10%', factor: 0.9 },
    { label: 'Stretch +10%', factor: 1.1 },
] as const;

export default function BudgetsPage() {
    const router = useRouter();
    const toast = useToast();
    const [budgets, setBudgets] = useState<Budget[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Create/edit modal state
    const [modalOpen, setModalOpen] = useState(false);
    const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
    const [selectedBudget, setSelectedBudget] = useState<Budget | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<Budget | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    // Scenario modal state
    const [scenarioOpen, setScenarioOpen] = useState(false);
    const [scenarioSource, setScenarioSource] = useState('');
    const [scenarioName, setScenarioName] = useState('');
    const [scenarioFactor, setScenarioFactor] = useState(0.9);
    const [scenarioCustomPct, setScenarioCustomPct] = useState('');
    const [scenarioMode, setScenarioMode] = useState<'preset' | 'custom'>('preset');
    const [scenarioSaving, setScenarioSaving] = useState(false);
    const [scenarioError, setScenarioError] = useState<string | null>(null);

    const fetchBudgets = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/budgets');
            if (!res.ok) throw new Error('Failed to fetch budgets');
            const data = await res.json();
            setBudgets(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchBudgets();
    }, [fetchBudgets]);

    const handleCreate = () => {
        setSelectedBudget(null);
        setModalMode('create');
        setModalOpen(true);
    };

    const handleEdit = async (budget: Budget) => {
        // Fetch full budget details to get recurrence info
        try {
            const res = await fetch(`/api/budgets/${budget.guid}`);
            if (res.ok) {
                const fullBudget = await res.json();
                setSelectedBudget(fullBudget);
            } else {
                setSelectedBudget(budget);
            }
        } catch (err) {
            console.error('Error fetching budget details:', err);
            setSelectedBudget(budget);
        }
        setModalMode('edit');
        setModalOpen(true);
    };

    const handleDeleteConfirm = (budget: Budget) => {
        setDeleteConfirm(budget);
        setDeleteError(null);
    };

    const handleDelete = async () => {
        if (!deleteConfirm) return;

        setDeleting(true);
        setDeleteError(null);

        try {
            const res = await fetch(`/api/budgets/${deleteConfirm.guid}`, {
                method: 'DELETE',
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || 'Failed to delete budget');
            }

            setDeleteConfirm(null);
            fetchBudgets();
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : 'Failed to delete budget');
        } finally {
            setDeleting(false);
        }
    };

    const handleSave = async (data: { name: string; description: string; num_periods: number }) => {
        const url = modalMode === 'create'
            ? '/api/budgets'
            : `/api/budgets/${selectedBudget?.guid}`;
        const method = modalMode === 'create' ? 'POST' : 'PUT';

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        if (!res.ok) {
            const errorData = await res.json();
            throw new Error(errorData.error || errorData.errors?.[0]?.message || 'Failed to save budget');
        }

        setModalOpen(false);
        fetchBudgets();
    };

    const openScenarioModal = (source?: Budget) => {
        const seed = source ?? budgets[0];
        setScenarioSource(seed?.guid || '');
        setScenarioMode('preset');
        setScenarioFactor(0.9);
        setScenarioCustomPct('');
        setScenarioName(seed ? `${seed.name} (Lean −10%)` : '');
        setScenarioError(null);
        setScenarioOpen(true);
    };

    const scenarioDefaultName = (sourceGuid: string, factor: number, mode: 'preset' | 'custom') => {
        const src = budgets.find(b => b.guid === sourceGuid);
        if (!src) return '';
        if (mode === 'preset') {
            const preset = SCENARIO_PRESETS.find(p => p.factor === factor);
            if (preset) return `${src.name} (${preset.label})`;
        }
        const pct = Math.round((factor - 1) * 100);
        return `${src.name} (${pct >= 0 ? '+' : ''}${pct}%)`;
    };

    const effectiveFactor = scenarioMode === 'custom'
        ? 1 + (parseFloat(scenarioCustomPct) || 0) / 100
        : scenarioFactor;

    const handleScenarioCreate = async () => {
        if (!scenarioSource || !scenarioName.trim() || scenarioSaving) return;
        if (!(effectiveFactor > 0)) {
            setScenarioError('Factor must be greater than 0');
            return;
        }
        setScenarioSaving(true);
        setScenarioError(null);
        try {
            const res = await fetch(`/api/budgets/${scenarioSource}/scenario`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: scenarioName.trim(), factor: effectiveFactor }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to create scenario');
            setScenarioOpen(false);
            toast.success(`Scenario "${scenarioName.trim()}" created`);
            fetchBudgets();
        } catch (err) {
            setScenarioError(err instanceof Error ? err.message : 'Failed to create scenario');
        } finally {
            setScenarioSaving(false);
        }
    };

    const inputClass =
        'w-full px-2 py-1.5 bg-background-tertiary border border-border rounded-md text-foreground text-sm';

    return (
        <div className="space-y-6">
            <PageHeader
                title="Budgets"
                subtitle="Create and manage your financial budgets."
                actions={
                    <>
                        <button
                            onClick={handleCreate}
                            className="flex items-center gap-2 px-3 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            New budget
                        </button>
                        <Link
                            href="/budgets/new"
                            className="px-3 py-2 text-sm border border-border rounded-lg text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                        >
                            From history…
                        </Link>
                    </>
                }
                menuActions={[
                    {
                        label: 'Duplicate as scenario…',
                        onSelect: () => openScenarioModal(),
                        disabled: budgets.length === 0,
                    },
                    {
                        label: 'Compare budgets…',
                        onSelect: () => router.push(budgets[0] ? `/budgets/compare?a=${budgets[0].guid}` : '/budgets/compare'),
                        disabled: budgets.length === 0,
                    },
                ]}
            />

            {loading ? (
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading budgets...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="bg-surface/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-12 text-center">
                    <div className="text-rose-400">{error}</div>
                </div>
            ) : (
                <BudgetList
                    budgets={budgets}
                    onEdit={handleEdit}
                    onDelete={handleDeleteConfirm}
                    onScenario={openScenarioModal}
                />
            )}

            {/* Budget Form Modal */}
            <Modal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                title={modalMode === 'create' ? 'Create Budget' : 'Edit Budget'}
                size="md"
            >
                <div className="p-6">
                    <BudgetForm
                        mode={modalMode}
                        initialData={selectedBudget ? {
                            name: selectedBudget.name,
                            description: selectedBudget.description || '',
                            num_periods: selectedBudget.num_periods,
                            recurrence_period_type: selectedBudget.recurrence?.period_type,
                        } : undefined}
                        onSave={handleSave}
                        onCancel={() => setModalOpen(false)}
                    />
                </div>
            </Modal>

            {/* Scenario Modal */}
            <Modal
                isOpen={scenarioOpen}
                onClose={() => setScenarioOpen(false)}
                title="Duplicate as Scenario"
                size="sm"
            >
                <div className="p-6 space-y-4">
                    {scenarioError && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 text-rose-400 text-sm">
                            {scenarioError}
                        </div>
                    )}
                    <label className="block">
                        <span className="block text-xs text-foreground-secondary mb-1">Source budget</span>
                        <select
                            value={scenarioSource}
                            onChange={e => {
                                setScenarioSource(e.target.value);
                                setScenarioName(scenarioDefaultName(e.target.value, effectiveFactor, scenarioMode));
                            }}
                            className={inputClass}
                        >
                            {budgets.map(b => (
                                <option key={b.guid} value={b.guid}>{b.name}</option>
                            ))}
                        </select>
                    </label>
                    <div>
                        <span className="block text-xs text-foreground-secondary mb-1">Adjustment</span>
                        <div className="flex items-center gap-2">
                            {SCENARIO_PRESETS.map(preset => (
                                <button
                                    key={preset.label}
                                    onClick={() => {
                                        setScenarioMode('preset');
                                        setScenarioFactor(preset.factor);
                                        setScenarioName(scenarioDefaultName(scenarioSource, preset.factor, 'preset'));
                                    }}
                                    className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                                        scenarioMode === 'preset' && scenarioFactor === preset.factor
                                            ? 'border-primary/60 bg-primary-light text-primary'
                                            : 'border-border text-foreground-secondary hover:text-foreground hover:border-border-hover'
                                    }`}
                                >
                                    {preset.label}
                                </button>
                            ))}
                            <div className={`flex items-center gap-1 px-2 py-1 rounded-md border ${
                                scenarioMode === 'custom' ? 'border-primary/60 bg-primary-light' : 'border-border'
                            }`}>
                                <input
                                    type="number"
                                    step={1}
                                    value={scenarioCustomPct}
                                    onFocus={() => setScenarioMode('custom')}
                                    onChange={e => {
                                        setScenarioMode('custom');
                                        setScenarioCustomPct(e.target.value);
                                        const factor = 1 + (parseFloat(e.target.value) || 0) / 100;
                                        setScenarioName(scenarioDefaultName(scenarioSource, factor, 'custom'));
                                    }}
                                    placeholder="±%"
                                    className="w-14 bg-transparent text-sm font-mono tabular-nums text-right text-foreground focus:outline-none"
                                />
                                <span className="text-xs text-foreground-muted">%</span>
                            </div>
                        </div>
                    </div>
                    <label className="block">
                        <span className="block text-xs text-foreground-secondary mb-1">New budget name</span>
                        <input
                            type="text"
                            value={scenarioName}
                            onChange={e => setScenarioName(e.target.value)}
                            className={inputClass}
                        />
                    </label>
                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            onClick={() => setScenarioOpen(false)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleScenarioCreate}
                            disabled={scenarioSaving || !scenarioSource || !scenarioName.trim()}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:opacity-50 text-primary-foreground rounded-lg transition-colors"
                        >
                            {scenarioSaving ? 'Creating…' : 'Create scenario'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={deleteConfirm !== null}
                onClose={() => setDeleteConfirm(null)}
                title="Delete Budget"
                size="sm"
            >
                <div className="p-6 space-y-4">
                    {deleteError && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-rose-400 text-sm">
                            {deleteError}
                        </div>
                    )}
                    <p className="text-foreground-secondary">
                        Are you sure you want to delete <strong className="text-foreground">{deleteConfirm?.name}</strong>?
                    </p>
                    <p className="text-sm text-foreground-muted">
                        This will delete all budget allocations. This action cannot be undone.
                    </p>
                    <div className="flex justify-end gap-3 pt-4">
                        <button
                            onClick={() => setDeleteConfirm(null)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleDelete}
                            disabled={deleting}
                            className="px-4 py-2 text-sm bg-rose-600 hover:bg-rose-500 disabled:bg-rose-600/50 text-white rounded-lg transition-colors"
                        >
                            {deleting ? 'Deleting...' : 'Delete Budget'}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
