'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_PLAN_GUARDRAILS,
  LIFE_EVENT_TYPES,
  type LifeEvent,
  type LifeEventType,
  type LivingPlan,
  type PlanGuardrails,
} from '@/lib/planning/types';

const EVENT_LABELS: Record<LifeEventType, string> = {
  job_change: 'Job change',
  child: 'Child',
  move: 'Move',
  home_purchase: 'Home purchase',
  rental: 'Rental',
  sabbatical: 'Sabbatical',
  retirement: 'Retirement',
  education: 'Education',
  vehicle_replacement: 'Vehicle replacement',
  business_transition: 'Business transition',
  equity_vest: 'Equity vest',
  custom: 'Custom event',
};

function money(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency === 'UNKNOWN' ? 'USD' : currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function createEvent(type: LifeEventType): LifeEvent {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return {
    id: crypto.randomUUID(),
    type,
    title: EVENT_LABELS[type],
    date: date.toISOString().slice(0, 10),
    cashImpact: null,
    notes: null,
  };
}

const INPUT = 'w-full rounded-lg border border-border bg-background-tertiary px-3 py-2 text-sm text-foreground focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60';

export default function LivingPlanPage() {
  const [plan, setPlan] = useState<LivingPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lifeEvents, setLifeEvents] = useState<LifeEvent[]>([]);
  const [guardrails, setGuardrails] = useState<PlanGuardrails>(DEFAULT_PLAN_GUARDRAILS);
  const [template, setTemplate] = useState<LifeEventType>('job_change');
  const [decision, setDecision] = useState({
    title: '',
    alternatives: '',
    assumptions: '',
    selectedAction: '',
    expectedImpact: '',
    actualOutcome: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/planning/living-plan', { cache: 'no-store' });
      if (!response.ok) throw new Error('The living plan could not be loaded.');
      const data = await response.json() as { plan: LivingPlan | null };
      setPlan(data.plan);
      if (data.plan) {
        setLifeEvents(data.plan.version.lifeEvents);
        setGuardrails(data.plan.version.guardrails);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The living plan could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (body: Record<string, unknown>, success: string) => {
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/planning/living-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { plan?: LivingPlan | null; error?: string };
      if (!response.ok) throw new Error(data.error || 'The plan update failed.');
      setPlan(data.plan ?? null);
      if (data.plan) {
        setLifeEvents(data.plan.version.lifeEvents);
        setGuardrails(data.plan.version.guardrails);
      }
      setMessage(success);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The plan update failed.');
      return false;
    } finally {
      setWorking(false);
    }
  };

  const saveVersion = () => {
    if (!plan) return;
    void mutate({
      action: 'adopt',
      scenario: plan.version.scenario,
      assumptions: plan.version.assumptions,
      lifeEvents,
      guardrails,
      changeNote: 'Updated life events and guardrails',
    }, 'A new plan version was adopted.');
  };

  const addDecision = async () => {
    const saved = await mutate({
      action: 'decision',
      title: decision.title,
      alternatives: decision.alternatives.split('\n').filter(Boolean),
      assumptions: decision.assumptions.split('\n').filter(Boolean),
      selectedAction: decision.selectedAction,
      expectedImpact: decision.expectedImpact,
      actualOutcome: decision.actualOutcome,
    }, 'Decision added to the journal.');
    if (saved) {
      setDecision({ title: '', alternatives: '', assumptions: '', selectedAction: '', expectedImpact: '', actualOutcome: '' });
    }
  };

  const latest = plan?.reconciliations[0] ?? null;
  const breaches = latest?.guardrailResults.filter(result => result.status !== 'pass') ?? [];
  const headline = useMemo(() => {
    if (!plan) return [];
    return [
      ['Current net worth', money(latest?.actualBaseline.netWorth ?? plan.version.baseline.netWorth, plan.currency)],
      ['Ending plan net worth', money(plan.version.projection.netWorth.endingScenario, plan.currency)],
      ['Annual tax impact', money(plan.version.projection.tax.steadyStateAnnualDelta, plan.currency)],
      ['FIRE shift', plan.version.projection.fire.shiftYears === null
        ? 'Not reached'
        : `${plan.version.projection.fire.shiftYears > 0 ? '+' : ''}${plan.version.projection.fire.shiftYears} years`],
    ];
  }, [plan, latest]);

  if (loading) {
    return <div className="mx-auto max-w-6xl p-6 text-sm text-foreground-muted">Loading the adopted financial plan…</div>;
  }

  if (!plan) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <div className="rounded-lg border border-border bg-surface p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Living plan of record</p>
          <h1 className="mt-2 text-2xl font-bold text-foreground">No scenario has been adopted yet</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-foreground-secondary">
            Build a deterministic scenario, inspect its cash, tax, net-worth, and FIRE effects, then adopt it as the baseline this page will reconcile to actual books.
          </p>
          {error && <p className="mt-4 text-sm text-negative">{error}</p>}
          <Link href="/tools/scenario" className="mt-5 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background hover:bg-primary-hover">
            Open Scenario Sandbox
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Adopted baseline · Version {plan.currentVersion}</p>
          <h1 className="mt-1 text-2xl font-bold text-foreground">{plan.name}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            Adopted {new Date(plan.adoptedAt).toLocaleDateString()} · last actuals {latest?.period ?? 'not reconciled'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/tools/scenario" className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground-secondary hover:border-primary/50 hover:text-primary">
            Model alternative
          </Link>
          <button
            type="button"
            disabled={working}
            onClick={() => void mutate({ action: 'reconcile' }, 'Plan reconciled to current books.')}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-background hover:bg-primary-hover disabled:opacity-50"
          >
            {working ? 'Working…' : 'Reconcile actuals'}
          </button>
        </div>
      </header>

      {error && <div className="rounded-lg border border-negative/40 bg-negative/10 p-3 text-sm text-negative">{error}</div>}
      {message && <div className="rounded-lg border border-positive/40 bg-positive/10 p-3 text-sm text-positive">{message}</div>}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {headline.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-4">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">{label}</p>
            <p className="mt-1 font-mono text-lg font-semibold text-foreground">{value}</p>
          </div>
        ))}
      </section>

      {latest && (
        <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-lg border border-border bg-surface/30 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">Actual versus plan · {latest.period}</h2>
              <span className="font-mono text-xs text-foreground-muted">{new Date(latest.reconciledAt).toLocaleString()}</span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {Object.entries(latest.variances).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2">
                  <span className="text-xs capitalize text-foreground-secondary">{key.replace(/([A-Z])/g, ' $1')}</span>
                  <span className={`font-mono text-xs font-semibold ${
                    value === null ? 'text-foreground-muted' : value >= 0 ? 'text-positive' : 'text-negative'
                  }`}>
                    {value === null ? '—' : money(value, plan.currency)}
                  </span>
                </div>
              ))}
            </div>
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-foreground-muted">Cause attribution</h3>
            <div className="mt-2 space-y-2">
              {latest.causes.map(cause => (
                <div key={cause.key} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-foreground">{cause.label}</p>
                    <p className={`font-mono text-sm ${cause.amount >= 0 ? 'text-positive' : 'text-negative'}`}>{money(cause.amount, plan.currency)}</p>
                  </div>
                  <p className="mt-1 text-xs text-foreground-muted">{cause.explanation}</p>
                </div>
              ))}
              {latest.causes.length === 0 && <p className="text-sm text-foreground-muted">No material baseline variances detected.</p>}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface/30 p-5">
            <h2 className="text-base font-semibold text-foreground">Guardrails</h2>
            <p className="mt-1 text-xs text-foreground-muted">{breaches.length} item{breaches.length === 1 ? '' : 's'} need attention.</p>
            <div className="mt-4 space-y-2">
              {latest.guardrailResults.map(result => (
                <div key={result.key} className={`rounded-lg border p-3 ${
                  result.status === 'breach'
                    ? 'border-negative/40'
                    : result.status === 'warning' ? 'border-warning/40' : 'border-border'
                }`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{result.label}</p>
                    <span className={`text-[10px] font-semibold uppercase ${
                      result.status === 'breach'
                        ? 'text-negative'
                        : result.status === 'warning' ? 'text-warning' : 'text-positive'
                    }`}>{result.status}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-foreground-muted">{result.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-border bg-surface/30 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Life-event timeline</h2>
            <p className="mt-1 text-xs text-foreground-muted">These events also appear on the unified Money Timeline.</p>
          </div>
          <div className="flex gap-2">
            <select value={template} onChange={event => setTemplate(event.target.value as LifeEventType)} className={`${INPUT} w-48`}>
              {LIFE_EVENT_TYPES.map(type => <option key={type} value={type}>{EVENT_LABELS[type]}</option>)}
            </select>
            <button type="button" onClick={() => setLifeEvents(events => [...events, createEvent(template)])} className="rounded-lg border border-primary/50 px-3 py-2 text-xs font-semibold text-primary">
              Add event
            </button>
          </div>
        </div>
        <div className="mt-4 space-y-2">
          {lifeEvents.map((event, index) => (
            <div key={event.id} className="grid gap-2 rounded-lg border border-border bg-surface p-3 md:grid-cols-[150px_1fr_150px_150px_auto]">
              <select
                value={event.type}
                onChange={e => setLifeEvents(items => items.map((item, i) => i === index ? { ...item, type: e.target.value as LifeEventType } : item))}
                className={INPUT}
              >
                {LIFE_EVENT_TYPES.map(type => <option key={type} value={type}>{EVENT_LABELS[type]}</option>)}
              </select>
              <input value={event.title} onChange={e => setLifeEvents(items => items.map((item, i) => i === index ? { ...item, title: e.target.value } : item))} className={INPUT} aria-label="Event title" />
              <input type="date" value={event.date} onChange={e => setLifeEvents(items => items.map((item, i) => i === index ? { ...item, date: e.target.value } : item))} className={`${INPUT} font-mono`} />
              <input type="number" value={event.cashImpact ?? ''} placeholder="Cash impact" onChange={e => setLifeEvents(items => items.map((item, i) => i === index ? { ...item, cashImpact: e.target.value === '' ? null : Number(e.target.value) } : item))} className={`${INPUT} font-mono`} />
              <button type="button" onClick={() => setLifeEvents(items => items.filter((_, i) => i !== index))} className="px-2 text-xs text-foreground-muted hover:text-negative">Remove</button>
            </div>
          ))}
          {lifeEvents.length === 0 && <p className="py-4 text-center text-sm text-foreground-muted">No dated life events yet.</p>}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface/30 p-5">
          <h2 className="text-base font-semibold text-foreground">Plan guardrails</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-foreground-secondary">
              Minimum cash
              <input type="number" value={guardrails.minimumCash} onChange={e => setGuardrails(g => ({ ...g, minimumCash: Number(e.target.value) || 0 }))} className={`${INPUT} mt-1 font-mono`} />
            </label>
            <label className="text-xs text-foreground-secondary">
              Debt payoff by
              <input type="date" value={guardrails.debtPayoffBy ?? ''} onChange={e => setGuardrails(g => ({ ...g, debtPayoffBy: e.target.value || null }))} className={`${INPUT} mt-1 font-mono`} />
            </label>
            <label className="sm:col-span-2 text-xs text-foreground-secondary">
              Contribution priority (comma-separated)
              <input value={guardrails.contributionPriority.join(', ')} onChange={e => setGuardrails(g => ({ ...g, contributionPriority: e.target.value.split(',').map(v => v.trim()).filter(Boolean) }))} className={`${INPUT} mt-1`} />
            </label>
            <label className="sm:col-span-2 flex items-center gap-2 text-xs text-foreground-secondary">
              <input type="checkbox" checked={guardrails.enforceGoalDeadlines} onChange={e => setGuardrails(g => ({ ...g, enforceGoalDeadlines: e.target.checked }))} />
              Treat missed goal deadlines as guardrail breaches
            </label>
          </div>
          <button type="button" disabled={working} onClick={saveVersion} className="mt-4 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-background disabled:opacity-50">
            Save as version {plan.currentVersion + 1}
          </button>
        </div>

        <div className="rounded-lg border border-border bg-surface/30 p-5">
          <h2 className="text-base font-semibold text-foreground">Decision journal</h2>
          <div className="mt-4 grid gap-2">
            <input placeholder="Decision title" value={decision.title} onChange={e => setDecision(d => ({ ...d, title: e.target.value }))} className={INPUT} />
            <textarea placeholder="Alternatives considered · one per line" value={decision.alternatives} onChange={e => setDecision(d => ({ ...d, alternatives: e.target.value }))} className={`${INPUT} min-h-20`} />
            <textarea placeholder="Assumptions · one per line" value={decision.assumptions} onChange={e => setDecision(d => ({ ...d, assumptions: e.target.value }))} className={`${INPUT} min-h-16`} />
            <input placeholder="Selected action" value={decision.selectedAction} onChange={e => setDecision(d => ({ ...d, selectedAction: e.target.value }))} className={INPUT} />
            <input placeholder="Expected impact" value={decision.expectedImpact} onChange={e => setDecision(d => ({ ...d, expectedImpact: e.target.value }))} className={INPUT} />
            <button type="button" disabled={working || !decision.title.trim() || !decision.selectedAction.trim()} onClick={() => void addDecision()} className="justify-self-start rounded-lg border border-primary/50 px-3 py-2 text-xs font-semibold text-primary disabled:opacity-50">
              Add decision
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface/30 p-5">
        <h2 className="text-base font-semibold text-foreground">Journal history</h2>
        <div className="mt-3 space-y-2">
          {plan.decisions.map(item => (
            <article key={item.id} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">{item.title}</p>
                  <p className="mt-1 text-xs text-foreground-secondary">Selected: {item.selectedAction}</p>
                  {item.expectedImpact && <p className="mt-1 text-xs text-foreground-muted">Expected: {item.expectedImpact}</p>}
                  {item.actualOutcome && <p className="mt-1 text-xs text-positive">Actual: {item.actualOutcome}</p>}
                </div>
                <time className="font-mono text-[11px] text-foreground-muted">{item.decidedAt.slice(0, 10)}</time>
              </div>
            </article>
          ))}
          {plan.decisions.length === 0 && <p className="text-sm text-foreground-muted">No decisions recorded yet.</p>}
        </div>
      </section>

      <div className="flex justify-end">
        <button type="button" onClick={() => void mutate({ action: 'archive' }, 'The plan was archived.')} disabled={working} className="text-xs text-foreground-muted hover:text-negative">
          Archive adopted plan
        </button>
      </div>
    </div>
  );
}
