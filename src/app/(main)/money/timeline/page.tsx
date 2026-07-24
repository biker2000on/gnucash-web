'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  FinancialEvent,
  FinancialEventDomain,
  MoneyTimeline,
  TimelineConflict,
} from '@/lib/money-timeline/types';

const DOMAIN_LABELS: Record<FinancialEventDomain, string> = {
  scheduled: 'Scheduled',
  fixed_income: 'Fixed income',
  rmd: 'RMD',
  compliance: 'Compliance',
  renewal: 'Renewals',
  home: 'Home',
  invoice: 'Invoices & bills',
  payment: 'Payments',
  reimbursement: 'Reimbursements',
  goal: 'Goals',
  equity_comp: 'Equity compensation',
  report_schedule: 'Report delivery',
  plan: 'Living plan',
};

const DOMAIN_COLORS: Record<FinancialEventDomain, string> = {
  scheduled: 'border-primary/40 text-primary',
  fixed_income: 'border-positive/40 text-positive',
  rmd: 'border-warning/40 text-warning',
  compliance: 'border-negative/40 text-negative',
  renewal: 'border-secondary/40 text-secondary',
  home: 'border-primary/40 text-primary',
  invoice: 'border-warning/40 text-warning',
  payment: 'border-positive/40 text-positive',
  reimbursement: 'border-primary/40 text-primary',
  goal: 'border-positive/40 text-positive',
  equity_comp: 'border-secondary/40 text-secondary',
  report_schedule: 'border-secondary/40 text-secondary',
  plan: 'border-primary/40 text-primary',
};

type ViewMode = 'day' | 'month' | 'year';

function dateKey(date: string, mode: ViewMode): string {
  if (mode === 'day') return date;
  if (mode === 'month') return date.slice(0, 7);
  return date.slice(0, 4);
}

function dateLabel(key: string, mode: ViewMode): string {
  if (mode === 'year') return key;
  const date = new Date(`${mode === 'month' ? `${key}-01` : key}T00:00:00`);
  return new Intl.DateTimeFormat('en-US', mode === 'month'
    ? { month: 'long', year: 'numeric' }
    : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
  ).format(date);
}

function money(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency === 'UNKNOWN' ? 'USD' : currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function EventRow({ event, currency }: { event: FinancialEvent; currency: string }) {
  const content = (
    <div className="flex min-w-0 flex-1 items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${DOMAIN_COLORS[event.domain]}`}>
            {DOMAIN_LABELS[event.domain]}
          </span>
          <span className="font-mono text-[11px] text-foreground-muted">{event.date}</span>
          {event.status === 'overdue' && (
            <span className="rounded bg-negative/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-negative">
              Overdue
            </span>
          )}
        </div>
        <p className="mt-1 text-sm font-medium text-foreground">{event.title}</p>
        {event.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-foreground-muted">{event.description}</p>
        )}
        <p className="mt-1 text-[10px] text-foreground-muted">
          {Math.round(event.confidence * 100)}% confidence · {event.evidence.length} evidence source{event.evidence.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`font-mono text-sm font-semibold ${
          event.cashImpact === null
            ? 'text-foreground-muted'
            : event.cashImpact >= 0 ? 'text-positive' : 'text-negative'
        }`}>
          {event.cashImpact === null
            ? 'No amount'
            : `${event.cashImpact > 0 ? '+' : ''}${money(event.cashImpact, event.currency || currency)}`}
        </p>
      </div>
    </div>
  );
  return event.href ? (
    <Link href={event.href} className="flex rounded-lg border border-border bg-surface p-3 hover:border-primary/50">
      {content}
    </Link>
  ) : (
    <div className="flex rounded-lg border border-border bg-surface p-3">{content}</div>
  );
}

function ConflictCard({ conflict, currency }: { conflict: TimelineConflict; currency: string }) {
  return (
    <div className={`rounded-lg border p-3 ${
      conflict.severity === 'critical'
        ? 'border-negative/40 bg-negative/5'
        : 'border-warning/40 bg-warning/5'
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={`text-sm font-semibold ${conflict.severity === 'critical' ? 'text-negative' : 'text-warning'}`}>
            {conflict.title}
          </p>
          <p className="mt-1 text-xs leading-5 text-foreground-secondary">{conflict.description}</p>
        </div>
        <span className="font-mono text-[11px] text-foreground-muted">{conflict.date}</span>
      </div>
      {conflict.projectedCash !== undefined && (
        <p className="mt-2 font-mono text-xs text-foreground">Projected cash {money(conflict.projectedCash, currency)}</p>
      )}
    </div>
  );
}

export default function MoneyTimelinePage() {
  const [timeline, setTimeline] = useState<MoneyTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('month');
  const [minimumCash, setMinimumCash] = useState(0);
  const [domains, setDomains] = useState<Set<FinancialEventDomain>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/money-timeline?minimumCash=${minimumCash}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('The Money Timeline could not be loaded.');
      setTimeline(await response.json() as MoneyTimeline);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The Money Timeline could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [minimumCash]);

  useEffect(() => { void load(); }, [load]);

  const visibleEvents = useMemo(() => {
    if (!timeline) return [];
    return domains.size === 0 ? timeline.events : timeline.events.filter(event => domains.has(event.domain));
  }, [timeline, domains]);
  const groups = useMemo(() => {
    const result = new Map<string, FinancialEvent[]>();
    for (const event of visibleEvents) {
      const key = dateKey(event.date, view);
      const list = result.get(key) ?? [];
      list.push(event);
      result.set(key, list);
    }
    return [...result.entries()];
  }, [visibleEvents, view]);

  const toggleDomain = (domain: FinancialEventDomain) => {
    setDomains(previous => {
      const next = new Set(previous);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Financial operating system</p>
          <h1 className="mt-1 text-2xl font-bold text-foreground">Money Timeline</h1>
          <p className="mt-1 max-w-2xl text-sm text-foreground-secondary">
            One chronology for obligations, expected cash, goals, and plan events—with conflicts found before they become surprises.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(['day', 'month', 'year'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={`rounded-lg border px-3 py-2 text-xs font-semibold capitalize ${
                view === mode ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground-secondary'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="rounded-lg border border-negative/40 bg-negative/10 p-4 text-sm text-negative">{error}</div>}
      {loading && !timeline && <div className="rounded-lg border border-border bg-surface p-8 text-sm text-foreground-muted">Loading the shared financial chronology…</div>}

      {timeline && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Events', String(timeline.events.length)],
              ['Needs attention', String(timeline.conflicts.length)],
              ['Opening cash', money(timeline.openingCash, timeline.currency)],
              ['Coverage', `${timeline.from} → ${timeline.to}`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-surface p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">{label}</p>
                <p className="mt-1 font-mono text-lg font-semibold text-foreground">{value}</p>
              </div>
            ))}
          </section>

          <section className="rounded-lg border border-border bg-surface/30 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {timeline.domains.map(item => (
                  <button
                    key={item.domain}
                    type="button"
                    onClick={() => toggleDomain(item.domain)}
                    className={`rounded border px-2 py-1 text-[11px] font-medium ${
                      domains.size === 0 || domains.has(item.domain)
                        ? DOMAIN_COLORS[item.domain]
                        : 'border-border text-foreground-muted opacity-60'
                    }`}
                  >
                    {DOMAIN_LABELS[item.domain]} {item.count}
                  </button>
                ))}
                {domains.size > 0 && (
                  <button type="button" onClick={() => setDomains(new Set())} className="px-2 py-1 text-[11px] text-primary">
                    Show all
                  </button>
                )}
              </div>
              <label className="flex items-center gap-2 text-xs text-foreground-secondary">
                Cash guardrail
                <input
                  type="number"
                  value={minimumCash}
                  min={0}
                  step={1000}
                  onChange={event => setMinimumCash(Number(event.target.value) || 0)}
                  className="w-28 rounded-lg border border-border bg-background-tertiary px-2 py-1.5 font-mono text-foreground"
                />
              </label>
            </div>
          </section>

          {timeline.conflicts.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-foreground-secondary">Conflicts & deadlines</h2>
              <div className="grid gap-3 lg:grid-cols-2">
                {timeline.conflicts.map(conflict => (
                  <ConflictCard key={conflict.id} conflict={conflict} currency={timeline.currency} />
                ))}
              </div>
            </section>
          )}

          <section className="space-y-6">
            {groups.map(([key, events]) => (
              <div key={key}>
                <div className="mb-2 flex items-baseline justify-between border-b border-border pb-2">
                  <h2 className="text-sm font-semibold text-foreground">{dateLabel(key, view)}</h2>
                  <span className="font-mono text-xs text-foreground-muted">
                    {events.length} event{events.length === 1 ? '' : 's'} · {money(events.reduce((sum, event) => sum + (event.cashImpact ?? 0), 0), timeline.currency)}
                  </span>
                </div>
                <div className="grid gap-2">
                  {events.map(event => <EventRow key={event.id} event={event} currency={timeline.currency} />)}
                </div>
              </div>
            ))}
            {groups.length === 0 && (
              <div className="rounded-lg border border-border bg-surface p-8 text-center text-sm text-foreground-muted">
                No events match these filters.
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
