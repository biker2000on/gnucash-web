'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { ProvenanceModal } from '@/components/provenance/ProvenanceModal';
import type {
  CalculationTrace,
  FinancialAction,
  FinancialActionLane,
  FinancialActionList,
  FinancialActionState,
} from '@/lib/financial-actions/types';

const LANES: Array<{
  id: FinancialActionLane;
  label: string;
  description: string;
  accent: string;
}> = [
  { id: 'fix', label: 'Fix', description: 'Make the books trustworthy', accent: 'border-negative/50' },
  { id: 'decide', label: 'Decide', description: 'Choose the highest-value next move', accent: 'border-warning/50' },
  { id: 'do', label: 'Do', description: 'Finish approved operations', accent: 'border-primary/50' },
];

const ORIGIN_LABELS: Record<FinancialAction['origin'], string> = {
  transaction_review: 'Transaction review',
  receipt_inbox: 'Receipt',
  statement_reconciliation: 'Statement',
  data_health: 'Data Health',
  insight: 'Insight',
  compliance: 'Compliance',
  business_close: 'Close',
  failed_job: 'Failed job',
  notification: 'Notification',
  opportunity: 'Opportunity',
};

function formatCurrency(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function impactLabel(action: FinancialAction): string | null {
  if (!action.impact) return null;
  if (action.impact.low === action.impact.high) return formatCurrency(action.impact.high);
  return `${formatCurrency(action.impact.low)}–${formatCurrency(action.impact.high)}`;
}

function snoozeDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function ActionCard({
  action,
  selected,
  focused,
  onSelect,
  onState,
  onExplain,
}: {
  action: FinancialAction;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
  onState: (state: FinancialActionState, snoozedUntil?: string) => void;
  onExplain: () => void;
}) {
  const touchStart = useRef<number | null>(null);
  const primary = action.operations.find(operation => operation.primary && operation.href)
    ?? action.operations.find(operation => operation.href);
  const amount = impactLabel(action);
  const cashRequired = typeof action.metadata?.cashRequired === 'number'
    ? action.metadata.cashRequired
    : null;
  const overdue = action.dueDate && action.dueDate < new Date().toISOString().slice(0, 10);

  return (
    <article
      data-action-id={action.id}
      className={`rounded-xl border bg-surface p-4 transition-colors ${
        selected || focused ? 'border-primary ring-1 ring-primary/30' : 'border-border hover:border-primary/40'
      }`}
      onTouchStart={event => {
        touchStart.current = event.changedTouches[0]?.clientX ?? null;
      }}
      onTouchEnd={event => {
        if (touchStart.current === null) return;
        const distance = (event.changedTouches[0]?.clientX ?? touchStart.current) - touchStart.current;
        touchStart.current = null;
        if (distance >= 90) onState('accepted');
        if (distance <= -90) onState('dismissed');
      }}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onSelect}
          aria-label={selected ? `Deselect ${action.title}` : `Select ${action.title}`}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
            selected ? 'border-primary bg-primary text-background' : 'border-border text-transparent hover:border-primary'
          }`}
        >
          ✓
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              action.severity === 'critical'
                ? 'bg-negative/15 text-negative'
                : action.severity === 'warning'
                  ? 'bg-warning/15 text-warning'
                  : 'bg-primary/10 text-primary'
            }`}>
              {action.severity}
            </span>
            <span className="text-[11px] text-foreground-muted">{ORIGIN_LABELS[action.origin]}</span>
            {action.state !== 'open' && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase text-foreground-secondary">
                {action.state}
              </span>
            )}
          </div>
          <h3 className="mt-2 text-sm font-semibold leading-5 text-foreground">{action.title}</h3>
          <p className="mt-1 text-xs leading-5 text-foreground-secondary">{action.summary}</p>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            {amount && (
              <span className="font-mono font-semibold text-positive">
                {amount} {action.impact?.period === 'annual' ? '/ yr' : ''}
              </span>
            )}
            {cashRequired !== null && cashRequired > 0 && (
              <span className="font-mono text-foreground-secondary">
                Cash required {formatCurrency(cashRequired)}
              </span>
            )}
            {action.score && (
              <span className="font-mono text-foreground-secondary">Score {Math.round(action.score.total)}</span>
            )}
            {action.dueDate && (
              <span className={overdue ? 'font-medium text-negative' : 'text-foreground-muted'}>
                {overdue ? 'Overdue ' : 'Due '}{action.dueDate}
              </span>
            )}
            <span className="text-foreground-muted">{Math.round(action.confidence * 100)}% confidence</span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {primary?.href && (
              <Link
                href={primary.href}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-background hover:bg-primary-hover"
              >
                {primary.label}
              </Link>
            )}
            {action.lane === 'decide' && action.state !== 'accepted' && (
              <button
                type="button"
                onClick={() => onState('accepted')}
                className="rounded-lg border border-positive/40 px-3 py-2 text-xs font-medium text-positive hover:bg-positive/10"
              >
                Accept
              </button>
            )}
            <button
              type="button"
              onClick={onExplain}
              className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:border-primary/50 hover:text-primary"
            >
              Show the math
            </button>
            <button
              type="button"
              onClick={() => onState('snoozed', snoozeDate(7))}
              className="rounded-lg px-2 py-2 text-xs text-foreground-muted hover:bg-surface-hover hover:text-foreground"
            >
              Snooze
            </button>
            <button
              type="button"
              onClick={() => onState(action.lane === 'do' ? 'resolved' : 'dismissed')}
              className="rounded-lg px-2 py-2 text-xs text-foreground-muted hover:bg-surface-hover hover:text-negative"
            >
              {action.lane === 'do' ? 'Resolve' : 'Dismiss'}
            </button>
          </div>
          <p className="mt-3 text-[10px] text-foreground-muted sm:hidden">
            Swipe right to accept · left to dismiss
          </p>
        </div>
      </div>
    </article>
  );
}

export default function FinancialActionCenterPage() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const familyScope = searchParams.get('scope') === 'family';
  const [data, setData] = useState<FinancialActionList | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [trace, setTrace] = useState<CalculationTrace | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/actions?includeCompleted=${includeCompleted}&refresh=${refresh}&scope=${familyScope ? 'family' : 'book'}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error('The Action Center could not be loaded.');
      setData(await response.json() as FinancialActionList);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load actions.');
    } finally {
      setLoading(false);
    }
  }, [includeCompleted, familyScope]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleActions = useMemo(() => data?.actions ?? [], [data]);

  const updateState = useCallback(async (
    ids: string[],
    state: FinancialActionState,
    snoozedUntil?: string,
  ) => {
    if (ids.length === 0 || mutating) return;
    setMutating(true);
    try {
      const response = await fetch(`/api/actions?scope=${familyScope ? 'family' : 'book'}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, state, snoozedUntil }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'The action update failed.');
      setSelected(new Set());
      toast.success(`${ids.length} action${ids.length === 1 ? '' : 's'} updated.`);
      await load();
    } catch (updateError) {
      toast.error(updateError instanceof Error ? updateError.message : 'Failed to update actions.');
    } finally {
      setMutating(false);
    }
  }, [familyScope, load, mutating, toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, button, a')) return;
      if (event.key === 'j') {
        event.preventDefault();
        setFocusedIndex(index => visibleActions.length === 0
          ? 0
          : Math.min(visibleActions.length - 1, index + 1));
      } else if (event.key === 'k') {
        event.preventDefault();
        setFocusedIndex(index => Math.max(0, index - 1));
      } else if (event.key === 'x' && visibleActions[focusedIndex]) {
        event.preventDefault();
        const id = visibleActions[focusedIndex].id;
        setSelected(current => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      } else if (event.key === 'a' && visibleActions[focusedIndex]) {
        event.preventDefault();
        void updateState([visibleActions[focusedIndex].id], 'accepted');
      } else if (event.key === 'd' && visibleActions[focusedIndex]) {
        event.preventDefault();
        void updateState([visibleActions[focusedIndex].id], 'dismissed');
      } else if (event.key === 's' && visibleActions[focusedIndex]) {
        event.preventDefault();
        void updateState([visibleActions[focusedIndex].id], 'snoozed', snoozeDate(7));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusedIndex, updateState, visibleActions]);

  const toggleSelected = (id: string) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-foreground">Financial Action Center</h1>
            {familyScope && (
              <span className="rounded border border-primary/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                Family graph
              </span>
            )}
            {data && data.summary.overdue > 0 && (
              <span className="rounded-full bg-negative/15 px-2 py-0.5 text-xs font-semibold text-negative">
                {data.summary.overdue} overdue
              </span>
            )}
          </div>
          <p className="mt-1 max-w-2xl text-sm text-foreground-secondary">
            A five-minute close for the issues, decisions, and operations that matter now.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/api/provenance/manifest?download=true"
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:border-primary/50 hover:text-primary"
          >
            Export evidence
          </Link>
          <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-foreground-secondary">
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={event => setIncludeCompleted(event.target.checked)}
              className="accent-primary"
            />
            Show completed
          </label>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading}
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:border-primary/50 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </header>

      {data && (
        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
          {[
            ['New this week', data.summary.new],
            ['Resolved', data.summary.resolved],
            ['Automated', data.summary.automated],
            ['Overdue', data.summary.overdue],
          ].map(([label, value]) => (
            <div key={label} className="bg-surface px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-foreground-muted">{label}</div>
              <div className="mt-1 font-mono text-xl font-semibold text-foreground">{value}</div>
            </div>
          ))}
        </section>
      )}

      {selected.size > 0 && (
        <div className="sticky top-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-background-secondary p-3 shadow-xl">
          <span className="mr-2 text-sm font-semibold text-foreground">{selected.size} selected</span>
          <button onClick={() => void updateState([...selected], 'accepted')} disabled={mutating} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-background disabled:opacity-50">
            Accept
          </button>
          <button onClick={() => void updateState([...selected], 'resolved')} disabled={mutating} className="rounded-lg border border-positive/40 px-3 py-2 text-xs font-medium text-positive disabled:opacity-50">
            Resolve
          </button>
          <button onClick={() => void updateState([...selected], 'snoozed', snoozeDate(7))} disabled={mutating} className="rounded-lg border border-border px-3 py-2 text-xs text-foreground-secondary disabled:opacity-50">
            Snooze 7 days
          </button>
          <button onClick={() => void updateState([...selected], 'dismissed')} disabled={mutating} className="rounded-lg px-3 py-2 text-xs text-negative disabled:opacity-50">
            Dismiss
          </button>
          <Link href="/settings/rules" className="rounded-lg px-3 py-2 text-xs text-foreground-secondary hover:text-primary">
            Create a rule
          </Link>
        </div>
      )}

      <div className="hidden text-right text-[11px] text-foreground-muted md:block">
        Keyboard: <span className="font-mono">j/k</span> move · <span className="font-mono">x</span> select · <span className="font-mono">a</span> accept · <span className="font-mono">s</span> snooze · <span className="font-mono">d</span> dismiss
      </div>

      {loading && (
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-48 animate-pulse rounded-xl border border-border bg-surface" />
          ))}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-negative/40 bg-negative/10 p-5">
          <p className="text-sm text-negative">{error}</p>
          <button onClick={() => void load()} className="mt-3 text-sm font-medium text-foreground underline">Try again</button>
        </div>
      )}

      {!loading && !error && data && data.actions.length === 0 && (
        <div className="rounded-xl border border-positive/30 bg-surface px-6 py-14 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-positive/40 text-xl text-positive">✓</div>
          <h2 className="mt-4 text-lg font-semibold text-foreground">
            {data.verifiedThrough ? 'Weekly close complete' : 'No actions pending'}
          </h2>
          <p className="mt-2 text-sm text-foreground-secondary">
            {data.verifiedThrough
              ? `Books reviewed through ${new Date(`${data.verifiedThrough}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`
              : 'No complete reconciliation coverage is available yet.'}
          </p>
        </div>
      )}

      {!loading && !error && data && data.actions.length > 0 && (
        <div className="grid gap-5 xl:grid-cols-3">
          {LANES.map(lane => {
            const actions = data.actions.filter(action => action.lane === lane.id);
            return (
              <section key={lane.id} className={`rounded-xl border-t-2 ${lane.accent}`}>
                <div className="flex items-end justify-between px-1 py-3">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">{lane.label}</h2>
                    <p className="text-xs text-foreground-muted">{lane.description}</p>
                  </div>
                  <span className="font-mono text-sm text-foreground-secondary">{actions.length}</span>
                </div>
                <div className="space-y-3">
                  {actions.length === 0 && (
                    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-foreground-muted">
                      Nothing in this lane.
                    </div>
                  )}
                  {actions.map(action => {
                    const index = visibleActions.findIndex(item => item.id === action.id);
                    return (
                      <ActionCard
                        key={action.id}
                        action={action}
                        selected={selected.has(action.id)}
                        focused={index === focusedIndex}
                        onSelect={() => toggleSelected(action.id)}
                        onState={(state, until) => void updateState([action.id], state, until)}
                        onExplain={() => setTrace(action.trace)}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <ProvenanceModal
        trace={trace}
        isOpen={trace !== null}
        onClose={() => setTrace(null)}
      />
    </div>
  );
}
