'use client';

import { useState, useEffect, useCallback } from 'react';
import { BudgetList } from '@/components/BudgetList';
import { BudgetForm } from '@/components/BudgetForm';
import { Modal } from '@/components/ui/Modal';

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

export default function BudgetsPage() {
    const [budgets, setBudgets] = useState<Budget[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Modal state
    const [modalOpen, setModalOpen] = useState(false);
    const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
    const [selectedBudget, setSelectedBudget] = useState<Budget | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<Budget | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

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

    return (
        <div className="space-y-6">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Budgets</h1>
                    <p className="text-foreground-muted">Create and manage your financial budgets.</p>
                </div>
                <button
                    onClick={handleCreate}
                    className="flex items-center gap-2 px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl transition-colors"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    New Budget
                </button>
            </header>

            {loading ? (
                <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
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
