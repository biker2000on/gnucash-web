'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@/contexts/ToastContext';
import {
    computeDifferenceCents,
    toCents,
    type ReconcileWorkspace,
} from '@/lib/reconcile-shared';
import { ReconcileSummary } from './ReconcileSummary';
import { CandidateTable } from './CandidateTable';

function todayIsoDate(): string {
    return new Date().toISOString().slice(0, 10);
}

/** Parse the ending-balance input; null when empty/invalid. */
function parseEndingBalance(raw: string): number | null {
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '' || cleaned === '-') return null;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : null;
}

function ReconcilePageContent() {
    const params = useParams();
    const guid = params.guid as string;
    const toast = useToast();

    const [statementDate, setStatementDate] = useState<string>(todayIsoDate);
    const [endingInput, setEndingInput] = useState<string>('');
    const [workspace, setWorkspace] = useState<ReconcileWorkspace | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [submitting, setSubmitting] = useState(false);
    const [finished, setFinished] = useState<{ count: number; date: string } | null>(null);
    const sessionId = useRef<string | null>(null);
    const pendingInteractions = useRef(0);

    const fetchWorkspace = useCallback(async () => {
        if (!guid || !statementDate) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/accounts/${guid}/reconcile?statementDate=${statementDate}`,
            );
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || 'Failed to load reconcile workspace');
            }
            const data: ReconcileWorkspace = await res.json();
            setWorkspace(data);
            // Keep only selections that are still candidates for this date.
            setSelected((prev) => {
                const valid = new Set(data.candidates.map((c) => c.guid));
                return new Set([...prev].filter((g) => valid.has(g)));
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setLoading(false);
        }
    }, [guid, statementDate]);

    useEffect(() => {
        fetchWorkspace();
    }, [fetchWorkspace]);

    useEffect(() => {
        sessionId.current = null;
        pendingInteractions.current = 0;
        if (!guid || !statementDate) return;
        let cancelled = false;
        fetch('/api/reconciliation/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountGuid: guid, statementDate }),
        })
            .then(response => response.ok ? response.json() : null)
            .then(body => {
                if (!cancelled && body?.id) {
                    sessionId.current = body.id;
                    if (pendingInteractions.current > 0) {
                        const interactionDelta = pendingInteractions.current;
                        pendingInteractions.current = 0;
                        fetch('/api/reconciliation/sessions', {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: body.id, interactionDelta }),
                        }).catch(() => undefined);
                    }
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
            const id = sessionId.current;
            if (id) {
                fetch('/api/reconciliation/sessions', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id,
                        status: 'abandoned',
                        interactionDelta: pendingInteractions.current,
                    }),
                    keepalive: true,
                }).catch(() => undefined);
            }
        };
    }, [guid, statementDate]);

    const recordInteraction = useCallback(() => {
        pendingInteractions.current += 1;
        if (!sessionId.current || pendingInteractions.current < 5) return;
        const interactionDelta = pendingInteractions.current;
        pendingInteractions.current = 0;
        fetch('/api/reconciliation/sessions', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: sessionId.current, interactionDelta }),
        }).catch(() => undefined);
    }, []);

    const toggle = useCallback((splitGuid: string) => {
        recordInteraction();
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(splitGuid)) next.delete(splitGuid);
            else next.add(splitGuid);
            return next;
        });
    }, [recordInteraction]);

    const selectAllCleared = useCallback(
        (select: boolean) => {
            if (!workspace) return;
            recordInteraction();
            setSelected((prev) => {
                const next = new Set(prev);
                for (const c of workspace.candidates) {
                    if (c.state !== 'c') continue;
                    if (select) next.add(c.guid);
                    else next.delete(c.guid);
                }
                return next;
            });
        },
        [workspace, recordInteraction],
    );

    const currency = workspace?.account.currency || 'USD';
    const endingBalance = parseEndingBalance(endingInput);

    const selectedAmounts = useMemo(() => {
        if (!workspace) return [];
        return workspace.candidates
            .filter((c) => selected.has(c.guid))
            .map((c) => c.amount);
    }, [workspace, selected]);

    const selectedTotalCents = useMemo(
        () => selectedAmounts.reduce((sum, a) => sum + toCents(a), 0),
        [selectedAmounts],
    );

    const differenceCents =
        workspace && endingBalance !== null
            ? computeDifferenceCents(endingBalance, workspace.reconciledBalance, selectedAmounts)
            : null;

    const canFinish =
        !loading && !submitting && workspace !== null &&
        endingBalance !== null && differenceCents === 0;

    const handleFinish = useCallback(async () => {
        if (!workspace || endingBalance === null || differenceCents !== 0) return;
        setSubmitting(true);
        try {
            const res = await fetch(`/api/accounts/${guid}/reconcile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    statementDate,
                    endingBalance,
                    splitGuids: [...selected],
                }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(body?.error || 'Failed to finalize reconciliation');
            }
            const count: number = body?.reconciledSplits ?? selected.size;
            if (sessionId.current) {
                await fetch('/api/reconciliation/sessions', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: sessionId.current,
                        status: 'completed',
                        interactionDelta: pendingInteractions.current,
                        endingDifference: differenceCents / 100,
                    }),
                }).catch(() => undefined);
                pendingInteractions.current = 0;
                sessionId.current = null;
            }
            toast.success(
                `Reconciled ${count} transaction${count === 1 ? '' : 's'} through ${statementDate}`,
            );
            setFinished({ count, date: statementDate });
            setSelected(new Set());
            fetchWorkspace();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to finalize reconciliation');
        } finally {
            setSubmitting(false);
        }
    }, [workspace, endingBalance, differenceCents, guid, statementDate, selected, toast, fetchWorkspace]);

    return (
        <div className="space-y-6">
            <header className="flex flex-col lg:flex-row lg:justify-between lg:items-end gap-4">
                <div>
                    <nav className="flex items-center gap-2 text-xs text-foreground-muted uppercase tracking-widest mb-2">
                        <Link href="/accounts" className="hover:text-primary transition-colors">
                            Accounts
                        </Link>
                        <span>/</span>
                        <Link
                            href={`/accounts/${guid}`}
                            className="hover:text-primary transition-colors"
                        >
                            {workspace?.account.name || 'Loading...'}
                        </Link>
                        <span>/</span>
                        <span className="text-foreground-secondary">Reconcile</span>
                    </nav>
                    <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
                        {workspace?.account.name || 'Loading...'}
                        <span className="text-xs font-normal px-2 py-1 rounded bg-background-tertiary text-foreground-muted border border-border-hover uppercase tracking-tighter">
                            Reconcile
                        </span>
                    </h1>
                </div>
                <div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-foreground-muted uppercase tracking-widest font-semibold">
                            Statement Date
                        </span>
                        <input
                            type="date"
                            value={statementDate}
                            onChange={(e) => setStatementDate(e.target.value)}
                            className="px-3 py-2 bg-surface border border-border rounded-md text-sm text-foreground font-mono focus:outline-none focus:border-border-hover"
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-foreground-muted uppercase tracking-widest font-semibold">
                            Ending Balance
                        </span>
                        <input
                            type="text"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={endingInput}
                            onChange={(e) => setEndingInput(e.target.value)}
                            className="px-3 py-2 bg-surface border border-border rounded-md text-sm text-foreground font-mono text-right focus:outline-none focus:border-border-hover w-40"
                            style={{ fontFeatureSettings: "'tnum'" }}
                        />
                    </label>
                </div>
            </header>

            {/* Running summary — always visible */}
            {workspace && (
                <ReconcileSummary
                    reconciledBalance={workspace.reconciledBalance}
                    selectedTotal={selectedTotalCents / 100}
                    endingBalance={endingBalance}
                    differenceCents={differenceCents}
                    currency={currency}
                    lastReconcileDate={workspace.lastReconcileDate}
                />
            )}

            {finished && (
                <div className="border border-border rounded-lg bg-surface p-4 flex items-center justify-between gap-4">
                    <p className="text-sm text-positive">
                        Reconciliation complete — {finished.count} transaction
                        {finished.count === 1 ? '' : 's'} marked reconciled through {finished.date}.
                    </p>
                    <Link
                        href={`/accounts/${guid}`}
                        className="px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors whitespace-nowrap"
                    >
                        Back to Ledger
                    </Link>
                </div>
            )}

            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => selectAllCleared(true)}
                        disabled={loading || !workspace?.candidates.some((c) => c.state === 'c')}
                        className="px-3 py-1.5 text-xs font-medium border border-border hover:border-border-hover text-foreground-secondary hover:text-foreground rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Auto-select Cleared
                    </button>
                    <button
                        onClick={() => {
                            recordInteraction();
                            setSelected(new Set());
                        }}
                        disabled={loading || selected.size === 0}
                        className="px-3 py-1.5 text-xs font-medium border border-border hover:border-border-hover text-foreground-secondary hover:text-foreground rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Clear Selection
                    </button>
                    <span className="text-xs text-foreground-muted">
                        {selected.size} of {workspace?.candidates.length ?? 0} selected
                    </span>
                </div>
                <button
                    onClick={handleFinish}
                    disabled={!canFinish}
                    title={
                        canFinish
                            ? 'Mark selected splits reconciled'
                            : 'Difference must be exactly 0.00 to finish'
                    }
                    className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {submitting ? 'Finishing...' : 'Finish'}
                </button>
            </div>

            {/* Candidates */}
            {loading ? (
                <div className="border border-border rounded-lg bg-surface p-12 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary text-sm">
                            Loading unreconciled transactions...
                        </span>
                    </div>
                </div>
            ) : error ? (
                <div className="border border-border rounded-lg bg-surface p-12 flex items-center justify-center">
                    <div className="text-negative text-sm">{error}</div>
                </div>
            ) : workspace ? (
                <CandidateTable
                    candidates={workspace.candidates}
                    selected={selected}
                    onToggle={toggle}
                    onSelectAllCleared={selectAllCleared}
                    currency={currency}
                />
            ) : null}
        </div>
    );
}

export default function ReconcilePage() {
    return (
        <Suspense
            fallback={
                <div className="space-y-6">
                    <header>
                        <nav className="flex items-center gap-2 text-xs text-foreground-muted uppercase tracking-widest mb-2">
                            <span>Accounts</span>
                            <span>/</span>
                            <span className="text-foreground-secondary">Reconcile</span>
                        </nav>
                        <h1 className="text-3xl font-bold text-foreground">Loading...</h1>
                    </header>
                </div>
            }
        >
            <ReconcilePageContent />
        </Suspense>
    );
}
