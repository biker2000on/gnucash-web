'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@/contexts/ToastContext';
import { notifyActionCenterUpdated } from '@/lib/financial-actions/client-events';
import {
    computeDifferenceUnits,
    toggleCandidateSelection,
    type ReconcileCandidate,
    type ReconcileWorkspace,
} from '@/lib/reconcile-shared';
import { TransactionFormModal } from '@/components/TransactionFormModal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { ReconcileSummary } from './ReconcileSummary';
import { CandidateTable } from './CandidateTable';
import { Tip } from '@/components/ui/Tooltip';

function todayIsoDate(): string {
    return new Date().toISOString().slice(0, 10);
}

/** Parse the ending-balance input; null when empty/invalid. */
function parseEndingBalance(raw: string): string | null {
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '' || cleaned === '-') return null;
    return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? cleaned : null;
}

function ReconcilePageContent() {
    const params = useParams();
    const guid = params.guid as string;
    const router = useRouter();
    const toast = useToast();

    const [statementDate, setStatementDate] = useState<string>(todayIsoDate);
    const [endingInput, setEndingInput] = useState<string>('');
    const [workspace, setWorkspace] = useState<ReconcileWorkspace | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [simpleFinBalance, setSimpleFinBalance] = useState<{
        balance: number;
        balanceDate: string | null;
    } | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [finished, setFinished] = useState<{ count: number; date: string } | null>(null);
    const [newTransactionOpen, setNewTransactionOpen] = useState(false);
    const [deleteCandidate, setDeleteCandidate] = useState<ReconcileCandidate | null>(null);
    const [deleting, setDeleting] = useState(false);
    const sessionId = useRef<string | null>(null);
    const sessionStart = useRef<Promise<string | null> | null>(null);
    const pendingInteractions = useRef(0);
    const selectionAnchor = useRef<number | null>(null);
    const endingInputTouched = useRef(false);

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
            selectionAnchor.current = null;
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
        const handleNewTransactionShortcut = (event: KeyboardEvent) => {
            if (
                event.altKey
                && !event.ctrlKey
                && !event.metaKey
                && !event.shiftKey
                && event.key.toLowerCase() === 'n'
                && !newTransactionOpen
                && !deleteCandidate
            ) {
                event.preventDefault();
                setNewTransactionOpen(true);
            }
        };
        window.addEventListener('keydown', handleNewTransactionShortcut);
        return () => window.removeEventListener('keydown', handleNewTransactionShortcut);
    }, [newTransactionOpen, deleteCandidate]);

    // Escape returns to this account's ledger, mirroring the ledger's own
    // Escape-back-to-hierarchy step. Focus inside an input blurs first, so a
    // stray Escape while typing the ending balance is not a navigation. The
    // transaction and delete dialogs never reach this handler at all — the
    // shared Modal answers Escape on `document` and stops propagation before
    // any window listener — but the guard keeps that true even if a dialog
    // ever opts out of closeOnEscape.
    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || newTransactionOpen || deleteCandidate) return;
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                event.preventDefault();
                target?.blur();
                return;
            }
            event.preventDefault();
            router.push(`/accounts/${guid}`);
        };
        window.addEventListener('keydown', handleEscape);
        return () => window.removeEventListener('keydown', handleEscape);
    }, [guid, newTransactionOpen, deleteCandidate, router]);

    useEffect(() => {
        if (!guid) return;
        setSimpleFinBalance(null);
        fetch(`/api/simplefin/balance/${guid}`)
            .then((response) => response.ok ? response.json() : null)
            .then((body) => {
                if (!body?.hasBalance || !Number.isFinite(Number(body.balance))) return;
                const nextBalance = {
                    balance: Number(body.balance),
                    balanceDate: typeof body.balanceDate === 'string' ? body.balanceDate : null,
                };
                setSimpleFinBalance(nextBalance);
                if (!endingInputTouched.current) {
                    setEndingInput(nextBalance.balance.toFixed(2));
                }
            })
            .catch(() => undefined);
    }, [guid]);

    useEffect(() => {
        sessionId.current = null;
        sessionStart.current = null;
        pendingInteractions.current = 0;
        if (!guid || !statementDate) return;
        let cancelled = false;
        const startPromise = fetch('/api/reconciliation/sessions', {
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
                    return body.id as string;
                }
                return null;
            })
            .catch(() => null);
        sessionStart.current = startPromise;
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

    const toggle = useCallback((index: number, shiftKey: boolean) => {
        if (!workspace) return;
        recordInteraction();
        const anchorIndex = selectionAnchor.current;
        setSelected((prev) =>
            toggleCandidateSelection(
                workspace.candidates,
                prev,
                index,
                anchorIndex,
                shiftKey,
            ),
        );
        selectionAnchor.current = index;
    }, [workspace, recordInteraction]);

    const selectAll = useCallback(
        (select: boolean) => {
            if (!workspace) return;
            recordInteraction();
            setSelected(select
                ? new Set(workspace.candidates.map((candidate) => candidate.guid))
                : new Set());
            selectionAnchor.current = null;
        },
        [workspace, recordInteraction],
    );

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
            selectionAnchor.current = null;
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

    const differenceCents =
        workspace && endingBalance !== null
            ? computeDifferenceUnits(endingBalance, workspace.reconciledBalance, selectedAmounts, workspace.account.commodityScu)
            : null;

    const canFinish =
        !loading && !submitting && workspace !== null &&
        endingBalance !== null && differenceCents === 0n;

    const handleFinish = useCallback(async () => {
        if (!workspace || endingBalance === null || differenceCents !== 0n) return;
        setSubmitting(true);
        try {
            const activeSessionId = sessionId.current ?? await sessionStart.current;
            const interactionDelta = pendingInteractions.current;
            const res = await fetch(`/api/accounts/${guid}/reconcile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    statementDate,
                    endingBalance,
                    splitGuids: [...selected],
                    sessionId: activeSessionId,
                    interactionDelta,
                }),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(body?.error || 'Failed to finalize reconciliation');
            }
            const count: number = body?.reconciledSplits ?? selected.size;
            pendingInteractions.current = 0;
            sessionId.current = null;
            sessionStart.current = null;
            notifyActionCenterUpdated('reconciliation-completed');
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

    const handleDelete = useCallback(async () => {
        if (!deleteCandidate || deleting) return;
        setDeleting(true);
        try {
            // Optimistic-lock token: only delete the version we loaded
            const tokenParam = `?original_enter_date=${encodeURIComponent(deleteCandidate.enterDate ?? 'null')}`;
            const res = await fetch(`/api/transactions/${deleteCandidate.transactionGuid}${tokenParam}`, {
                method: 'DELETE',
            });
            if (res.status === 409) {
                toast.error('This transaction was changed by someone else — reloading');
                setDeleteCandidate(null);
                await fetchWorkspace();
                return;
            }
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(body?.error || 'Failed to delete transaction');
            }
            recordInteraction();
            setSelected((prev) => {
                const next = new Set(prev);
                next.delete(deleteCandidate.guid);
                return next;
            });
            toast.success('Transaction deleted');
            setDeleteCandidate(null);
            await fetchWorkspace();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to delete transaction');
        } finally {
            setDeleting(false);
        }
    }, [deleteCandidate, deleting, recordInteraction, toast, fetchWorkspace]);

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
                            onChange={(e) => {
                                endingInputTouched.current = true;
                                setEndingInput(e.target.value);
                            }}
                            className="px-3 py-2 bg-surface border border-border rounded-md text-sm text-foreground font-mono text-right focus:outline-none focus:border-border-hover w-40"
                            style={{ fontFeatureSettings: "'tnum'" }}
                        />
                        {simpleFinBalance && (
                            <span className="text-[11px] text-foreground-muted">
                                From SimpleFIN
                                {simpleFinBalance.balanceDate
                                    ? ` · synced ${new Date(simpleFinBalance.balanceDate).toLocaleDateString()}`
                                    : ''}
                            </span>
                        )}
                    </label>
                </div>
            </header>

            {/* Running summary — pinned below the global application header. */}
            {workspace && (
                <div className="sticky top-[69px] z-20 -mx-1 bg-background/95 px-1 py-2 backdrop-blur-sm">
                    <ReconcileSummary
                        reconciledBalance={workspace.reconciledBalance}
                        selectedTotal={selectedAmounts.reduce((sum, amount) => sum + amount, 0)}
                        endingBalance={endingBalance === null ? null : Number(endingBalance)}
                        differenceCents={differenceCents === null ? null : Number(differenceCents)}
                        currency={currency}
                        commodityScu={workspace.account.commodityScu}
                        lastReconcileDate={workspace.lastReconcileDate}
                    />
                </div>
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
                        onClick={() => selectAll(true)}
                        disabled={
                            loading ||
                            !workspace?.candidates.length ||
                            selected.size === workspace.candidates.length
                        }
                        className="px-3 py-1.5 text-xs font-medium border border-border hover:border-border-hover text-foreground-secondary hover:text-foreground rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Select All
                    </button>
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
                            selectionAnchor.current = null;
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
                <div className="flex items-center gap-2">
                    <Tip content="New transaction (Alt+N)">
                    <button
                        type="button"
                        onClick={() => setNewTransactionOpen(true)}
                        className="px-3 py-2 text-sm font-medium border border-border hover:border-border-hover text-foreground-secondary hover:text-foreground rounded-md transition-colors"
                    >
                        New Transaction
                        <kbd className="ml-2 font-mono text-[10px] text-foreground-muted">Alt+N</kbd>
                    </button>
                    </Tip>
                    <Tip content={canFinish
                                ? 'Mark selected splits reconciled'
                                : 'Difference must be exactly 0.00 to finish'}>
                    <button
                        onClick={handleFinish}
                        disabled={!canFinish}
                        className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {submitting ? 'Finishing...' : 'Finish'}
                    </button>
                    </Tip>
                </div>
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
                    <div className="text-error text-sm">{error}</div>
                </div>
            ) : workspace ? (
                <CandidateTable
                    candidates={workspace.candidates}
                    selected={selected}
                    onToggle={toggle}
                    onSelectAll={selectAll}
                    onDelete={setDeleteCandidate}
                    currency={currency}
                    commodityScu={workspace.account.commodityScu}
                />
            ) : null}

            <TransactionFormModal
                isOpen={newTransactionOpen}
                onClose={() => setNewTransactionOpen(false)}
                defaultAccountGuid={guid}
                onSuccess={() => {
                    setNewTransactionOpen(false);
                    fetchWorkspace();
                }}
                onRefresh={fetchWorkspace}
            />

            <ConfirmationDialog
                isOpen={deleteCandidate !== null}
                onConfirm={handleDelete}
                onCancel={() => {
                    if (!deleting) setDeleteCandidate(null);
                }}
                title="Delete Transaction"
                message={
                    deleteCandidate
                        ? `Delete “${deleteCandidate.description || '(no description)'}” and all of its splits, including any cleared or reconciled splits in other accounts? This cannot be undone.`
                        : ''
                }
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={deleting}
            />
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
