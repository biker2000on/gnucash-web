'use client';

import Link from 'next/link';
import type { DomainCommandRecord } from '@/lib/domain-commands';

export function CommandPreviewCard({
  command,
  busy = false,
  onExecute,
  onUndo,
}: {
  command: DomainCommandRecord;
  busy?: boolean;
  onExecute?: (id: string) => void;
  onUndo?: (id: string) => void;
}) {
  const { preview } = command;
  return (
    <article className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-widest text-foreground-muted">
              {command.commandType}
            </span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
              command.status === 'executed' ? 'bg-positive/10 text-positive'
              : command.status === 'failed' ? 'bg-negative/10 text-negative'
              : command.status === 'undone' ? 'bg-surface-hover text-foreground-muted'
              : 'bg-primary-light text-primary'
            }`}>
              {command.status}
            </span>
          </div>
          <h3 className="mt-1 text-base font-semibold text-foreground">{preview.title}</h3>
          <p className="mt-1 text-sm text-foreground-secondary">{preview.summary}</p>
        </div>
        <div className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
          preview.balanced ? 'border-positive/30 text-positive' : 'border-negative/30 text-negative'
        }`}>
          {preview.balanced ? 'BALANCED' : `DELTA ${preview.balanceDelta.toFixed(2)}`}
        </div>
      </div>

      {preview.diff.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          {preview.diff.map(item => (
            <div key={item.field} className="grid grid-cols-[7rem_1fr] gap-3 border-b border-border px-3 py-2 text-xs last:border-0">
              <span className="text-foreground-muted">{item.field}</span>
              <span className="min-w-0 break-words text-foreground-secondary">
                {String(item.before ?? '—')} <span className="px-1 text-primary">→</span> {String(item.after ?? '—')}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-muted">Facts</p>
          <ul className="mt-1 space-y-1 text-xs text-foreground-secondary">
            {preview.facts.map(fact => <li key={fact}>• {fact}</li>)}
          </ul>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-muted">Assumptions</p>
          <ul className="mt-1 space-y-1 text-xs text-foreground-secondary">
            {preview.assumptions.length === 0
              ? <li>None</li>
              : preview.assumptions.map(item => <li key={item}>• {item}</li>)}
          </ul>
        </div>
      </div>

      {preview.warnings.map(warning => (
        <p key={warning} className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
          {warning}
        </p>
      ))}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <div className="flex flex-wrap gap-2">
          {preview.evidence.map(item => item.href ? (
            <Link key={`${item.kind}:${item.id}`} href={item.href} className="text-xs text-primary hover:text-primary-hover">
              {item.label}
            </Link>
          ) : (
            <span key={`${item.kind}:${item.id}`} className="text-xs text-foreground-muted">{item.label}</span>
          ))}
        </div>
        <div className="flex gap-2">
          {command.status === 'pending' && onExecute && (
            <button
              type="button"
              onClick={() => onExecute(command.id)}
              disabled={busy || !preview.balanced}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Executing…' : 'Approve & execute'}
            </button>
          )}
          {command.status === 'executed' && preview.reversible && onUndo && (
            <button
              type="button"
              onClick={() => onUndo(command.id)}
              disabled={busy}
              className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:text-foreground disabled:opacity-50"
            >
              {busy ? 'Undoing…' : 'Undo'}
            </button>
          )}
        </div>
      </div>
      {command.errorMessage && <p className="mt-3 text-xs text-negative">{command.errorMessage}</p>}
    </article>
  );
}
