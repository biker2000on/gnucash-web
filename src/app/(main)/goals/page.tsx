'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { GoalCard, type GoalWithProgress } from './GoalCard';
import { GoalForm, goalToFormValues, type GoalFormValues } from './GoalForm';

function valuesToBody(values: GoalFormValues) {
    const num = (s: string): number | null => {
        const t = s.trim();
        if (!t) return null;
        const n = parseFloat(t);
        return Number.isFinite(n) ? n : null;
    };
    return {
        name: values.name.trim(),
        goalType: values.goalType,
        targetAmount: num(values.targetAmount),
        targetMonths: num(values.targetMonths),
        targetDate: values.targetDate || null,
        accountGuid: values.accountGuid || null,
        monthlyContribution: num(values.monthlyContribution),
    };
}

export default function GoalsPage() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [goals, setGoals] = useState<GoalWithProgress[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [formOpen, setFormOpen] = useState(false);
    const [editing, setEditing] = useState<GoalWithProgress | null>(null);

    const [deleting, setDeleting] = useState<GoalWithProgress | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchGoals = useCallback(async () => {
        try {
            const res = await fetch('/api/goals');
            if (!res.ok) throw new Error('Failed to fetch goals');
            setGoals(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load goals');
        } finally {
            setLoading(false);
        }
    }, [error]);

    useEffect(() => {
        fetchGoals();
    }, [fetchGoals]);

    const openCreate = () => {
        setEditing(null);
        setFormOpen(true);
    };

    const openEdit = (goal: GoalWithProgress) => {
        setEditing(goal);
        setFormOpen(true);
    };

    const handleSubmit = async (values: GoalFormValues) => {
        setSaving(true);
        try {
            const body = valuesToBody(values);
            const url = editing ? `/api/goals/${editing.id}` : '/api/goals';
            const method = editing ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save goal');
            }
            success(editing ? 'Goal updated' : 'Goal created');
            setFormOpen(false);
            setEditing(null);
            await fetchGoals();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save goal');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/goals/${deleting.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete goal');
            }
            success('Goal deleted');
            setDeleting(null);
            await fetchGoals();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete goal');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="space-y-6">
            <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Goals</h1>
                    <p className="text-foreground-muted">
                        Track emergency funds, savings targets, and debt payoff — with projected completion dates.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={openCreate}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap self-start"
                >
                    + New Goal
                </button>
            </header>

            {loading ? (
                <div className="p-12 flex items-center justify-center gap-3">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading goals...</span>
                </div>
            ) : goals.length === 0 ? (
                <div className="bg-surface border border-border rounded-lg p-12 text-center">
                    <p className="text-foreground-muted mb-4">
                        No goals yet. Create one to start tracking your progress.
                    </p>
                    <button
                        type="button"
                        onClick={openCreate}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                    >
                        + New Goal
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {goals.map(goal => (
                        <GoalCard
                            key={goal.id}
                            goal={goal}
                            onEdit={openEdit}
                            onDelete={setDeleting}
                        />
                    ))}
                </div>
            )}

            {/* Create / edit modal */}
            <Modal
                isOpen={formOpen}
                onClose={() => {
                    setFormOpen(false);
                    setEditing(null);
                }}
                title={editing ? 'Edit Goal' : 'New Goal'}
                size="md"
            >
                <GoalForm
                    key={editing?.id ?? 'new'}
                    initial={goalToFormValues(editing)}
                    saving={saving}
                    submitLabel={editing ? 'Save' : 'Create Goal'}
                    onSubmit={handleSubmit}
                    onCancel={() => {
                        setFormOpen(false);
                        setEditing(null);
                    }}
                />
            </Modal>

            {/* Delete confirmation */}
            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title="Delete Goal"
                message={deleting ? `Delete goal "${deleting.name}"? This cannot be undone.` : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
