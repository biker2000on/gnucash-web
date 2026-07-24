'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { CommandPreviewCard } from '@/components/domain-commands/CommandPreviewCard';
import type { DomainCommandRecord } from '@/lib/domain-commands';

const INTENTS = [
  {
    id: 'close',
    title: 'Prepare weekly or month-end close',
    description: 'Inspect open actions, reconciliation coverage, and critical blockers. Preparation never locks the period.',
    href: '/business/close',
  },
  {
    id: 'schedule',
    title: 'Create or modify a schedule',
    description: 'Build a balanced schedule from scratch or seed one from a ledger transaction.',
    href: '/scheduled-transactions',
  },
  {
    id: 'reimburse',
    title: 'Review employee reimbursements',
    description: 'Approve a receipt-backed request into a draft voucher, reject it with a reason, or undo the decision.',
    href: '/business/reimbursements',
  },
  {
    id: 'reconcile',
    title: 'Continue reconciliation',
    description: 'Find stale accounts, statement gaps, and the verified-through date for the whole book.',
    href: '/reports/reconciliation',
  },
  {
    id: 'health',
    title: 'Resolve a Data Health issue',
    description: 'Open the evidence-backed structural checks before changing the books.',
    href: '/tools/data-health',
  },
] as const;

export default function SafeOperatorPage() {
  const { success, error } = useToast();
  const { isReadonly } = useCurrentUser();
  const [commands, setCommands] = useState<DomainCommandRecord[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/domain-commands');
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to load command history');
      setCommands(data.commands ?? []);
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to load command history');
    } finally {
      setLoading(false);
    }
  }, [error]);

  useEffect(() => { void load(); }, [load]);

  const matchedIntent = useMemo(() => {
    const value = prompt.toLowerCase();
    if (!value.trim()) return null;
    if (/close|weekly review|month.?end/.test(value)) return INTENTS[0];
    if (/schedule|recurring/.test(value)) return INTENTS[1];
    if (/reimburse|employee expense|receipt/.test(value)) return INTENTS[2];
    if (/reconcil|statement|tie.?out/.test(value)) return INTENTS[3];
    if (/health|unbalanced|stale price|integrity/.test(value)) return INTENTS[4];
    return null;
  }, [prompt]);

  const prepareClose = async () => {
    setBusyId('new-close');
    try {
      const res = await fetch('/api/domain-commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandType: 'close.prepare',
          input: { period: new Date().toISOString().slice(0, 7) },
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to preview close preparation');
      setCommands(current => [data.command, ...current]);
      success('Close preparation preview is ready');
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to preview close preparation');
    } finally {
      setBusyId(null);
    }
  };

  const mutate = async (id: string, operation: 'execute' | 'undo') => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/domain-commands/${id}/${operation}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Failed to ${operation} command`);
      setCommands(current => current.map(item => item.id === id ? data.command : item));
      success(operation === 'execute' ? 'Command executed' : 'Command undone');
    } catch (err) {
      error(err instanceof Error ? err.message : `Failed to ${operation} command`);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Safe Operator"
        subtitle="Bounded financial work with typed commands, balanced previews, scoped approval, evidence, audit, and undo."
      />

      <section className="rounded-xl border border-border bg-surface p-5">
        <label htmlFor="operator-request" className="text-xs font-semibold uppercase tracking-widest text-foreground-muted">
          What do you want to accomplish?
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="operator-request"
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder="Prepare my month-end close, review reimbursements, create a schedule…"
            className="min-w-0 flex-1 rounded-lg border border-border bg-input-bg px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-primary/50 focus:outline-none"
          />
          {matchedIntent?.id === 'close' ? (
            <button
              type="button"
              onClick={prepareClose}
              disabled={isReadonly || busyId === 'new-close'}
              title={isReadonly ? READONLY_TOOLTIP : undefined}
              className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              Preview close
            </button>
          ) : matchedIntent ? (
            <Link href={matchedIntent.href} className="rounded-lg bg-primary px-4 py-2.5 text-center text-sm font-semibold text-primary-foreground">
              Open workflow
            </Link>
          ) : (
            <button type="button" disabled className="rounded-lg border border-border px-4 py-2.5 text-sm text-foreground-muted">
              Choose a bounded workflow
            </button>
          )}
        </div>
        {prompt && !matchedIntent && (
          <p className="mt-2 text-xs text-warning">
            That request is outside the current command catalog. The operator will not improvise a write.
          </p>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-foreground-muted">Command catalog</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {INTENTS.map(intent => (
            <article key={intent.id} className="rounded-xl border border-border bg-surface p-4">
              <h3 className="font-semibold text-foreground">{intent.title}</h3>
              <p className="mt-1 text-sm text-foreground-secondary">{intent.description}</p>
              {intent.id === 'close' ? (
                <button
                  type="button"
                  onClick={prepareClose}
                  disabled={isReadonly || busyId === 'new-close'}
                  className="mt-4 text-xs font-medium text-primary disabled:opacity-50"
                >
                  Preview command →
                </button>
              ) : (
                <Link href={intent.href} className="mt-4 inline-block text-xs font-medium text-primary hover:text-primary-hover">
                  Open workflow →
                </Link>
              )}
            </article>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-foreground-muted">Command history</h2>
          <button type="button" onClick={() => void load()} className="text-xs text-primary">Refresh</button>
        </div>
        <div className="mt-3 space-y-3">
          {loading && <div className="h-32 animate-pulse rounded-xl border border-border bg-surface" />}
          {!loading && commands.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-foreground-muted">
              No command previews yet.
            </div>
          )}
          {commands.map(command => (
            <CommandPreviewCard
              key={command.id}
              command={command}
              busy={busyId === command.id}
              onExecute={id => void mutate(id, 'execute')}
              onUndo={id => void mutate(id, 'undo')}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
