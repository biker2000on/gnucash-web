'use client';

import type { ReactNode } from 'react';

// The form primitives are app-wide (see components/ui/form.tsx); they are
// re-exported here so the resilience pages keep a single import site.
export { INPUT, LABEL, TNUM, FieldGrid, RecordCard, Field } from '@/components/ui/form';
import { TNUM } from '@/components/ui/form';

export function Panel(props: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background-secondary/30">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">{props.title}</h2>
          {props.description && <p className="mt-1 text-xs text-foreground-muted">{props.description}</p>}
        </div>
        {props.action}
      </div>
      <div className="p-5">{props.children}</div>
    </section>
  );
}

export function Metric(props: { label: string; value: ReactNode; tone?: 'positive' | 'negative' | 'warning' }) {
  const tone = props.tone === 'positive'
    ? 'text-positive'
    : props.tone === 'negative'
      ? 'text-negative'
      : props.tone === 'warning'
        ? 'text-warning'
        : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-background-secondary/30 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">{props.label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold ${tone}`} style={TNUM}>{props.value}</p>
    </div>
  );
}

export function Tabs<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  tabs: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-border">
      {props.tabs.map(tab => (
        <button
          key={tab.value}
          type="button"
          onClick={() => props.onChange(tab.value)}
          className={`border-b-2 px-4 py-2 text-sm transition-colors ${
            props.value === tab.value
              ? 'border-primary text-primary'
              : 'border-transparent text-foreground-secondary hover:text-foreground'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function SaveBar(props: {
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  /** Optional: shown while dirty; reverts unsaved edits. */
  onDiscard?: () => void;
  message?: string | null;
}) {
  return (
    <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-elevated px-4 py-3 shadow-lg">
      <p className="text-xs text-foreground-secondary">
        {props.message ?? (props.dirty ? 'Unsaved changes' : 'All changes saved')}
      </p>
      <div className="flex items-center gap-2">
        {props.onDiscard && props.dirty && (
          <button
            type="button"
            onClick={props.onDiscard}
            disabled={props.saving}
            className="rounded-md border border-border px-4 py-2 text-sm text-foreground-secondary transition-colors hover:text-foreground disabled:opacity-50"
          >
            Discard
          </button>
        )}
        <button
          type="button"
          onClick={props.onSave}
          disabled={props.saving || !props.dirty}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {props.saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-foreground-muted">{props.children}</div>;
}
