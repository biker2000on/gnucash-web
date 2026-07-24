'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import type { CalculationTrace, EvidenceRef } from '@/lib/financial-actions/types';

const SOURCE_LABELS: Record<EvidenceRef['source'], string> = {
  manual: 'Manual',
  simplefin: 'SimpleFIN',
  statement: 'Statement',
  receipt: 'Receipt',
  payslip: 'Payslip',
  market_price: 'Market price',
  system: 'Calculated',
  rule: 'Rule',
};

function formatResult(trace: CalculationTrace): string {
  if (typeof trace.result !== 'number') return String(trace.result ?? '—');
  if (trace.unit === 'currency') {
    return trace.result.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  if (trace.unit === 'percent') return `${trace.result.toFixed(1)}%`;
  return trace.result.toLocaleString();
}

export function ProvenanceModal({
  traceId,
  trace: suppliedTrace,
  isOpen,
  onClose,
}: {
  traceId?: string | null;
  trace?: CalculationTrace | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [fetched, setFetched] = useState<{
    traceId: string;
    trace: CalculationTrace;
  } | null>(null);
  const [fetchError, setFetchError] = useState<{
    traceId: string;
    message: string;
  } | null>(null);
  const trace = suppliedTrace ?? (fetched && fetched.traceId === traceId ? fetched.trace : null);
  const error = fetchError && fetchError.traceId === traceId ? fetchError.message : null;
  const loading = isOpen && !trace && !error && Boolean(traceId);

  useEffect(() => {
    if (!isOpen || suppliedTrace || !traceId) return;
    const controller = new AbortController();
    fetch(`/api/provenance/${encodeURIComponent(traceId)}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('The calculation trace is not available.');
        return response.json() as Promise<CalculationTrace>;
      })
      .then(loadedTrace => {
        setFetched({ traceId, trace: loadedTrace });
        setFetchError(null);
      })
      .catch(fetchError => {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setFetchError({
          traceId,
          message: fetchError instanceof Error ? fetchError.message : 'Failed to load calculation trace.',
        });
      });
    return () => controller.abort();
  }, [isOpen, suppliedTrace, traceId]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Explain this number" size="lg">
      <div className="p-5 sm:p-6 space-y-6">
        {loading && <p className="text-sm text-foreground-secondary">Loading calculation trace…</p>}
        {error && <p className="text-sm text-negative">{error}</p>}
        {trace && (
          <>
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-mono text-primary">
                  {trace.id}
                </span>
                <span className="text-xs text-foreground-muted">As of {trace.asOfDate}</span>
              </div>
              <h3 className="text-xl font-semibold text-foreground">{trace.title}</h3>
              <p className="mt-2 text-sm leading-6 text-foreground-secondary">{trace.summary}</p>
              <div className="mt-4 border-l-2 border-primary pl-4">
                <div className="text-xs uppercase tracking-wider text-foreground-muted">Result</div>
                <div className="mt-1 text-2xl font-semibold font-mono text-foreground">{formatResult(trace)}</div>
                {trace.range && (
                  <div className="mt-1 text-xs text-foreground-secondary">
                    Range {trace.range.low.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                    {' – '}
                    {trace.range.high.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                  </div>
                )}
              </div>
            </div>

            {(trace.formula || trace.steps.length > 0) && (
              <section>
                <h4 className="text-sm font-semibold text-foreground">Calculation</h4>
                {trace.formula && (
                  <code className="mt-2 block overflow-x-auto rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground-secondary">
                    {trace.formula}
                  </code>
                )}
                <div className="mt-3 divide-y divide-border rounded-lg border border-border">
                  {trace.steps.map(step => (
                    <div key={step.key} className="p-3">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-sm font-medium text-foreground">{step.label}</div>
                          {step.formula && <div className="mt-1 text-xs font-mono text-foreground-muted">{step.formula}</div>}
                        </div>
                        <div className="shrink-0 font-mono text-sm text-foreground">
                          {typeof step.result === 'number' ? step.result.toLocaleString() : String(step.result ?? '—')}
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {Object.entries(step.inputs).map(([key, value]) => (
                          <span key={key} className="rounded border border-border px-2 py-1 text-[11px] text-foreground-secondary">
                            {key}: <span className="font-mono">{String(value ?? '—')}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <div className="flex items-center justify-between gap-4">
                <h4 className="text-sm font-semibold text-foreground">Evidence</h4>
                <Link
                  href="/api/provenance/manifest?download=true"
                  className="text-xs text-primary hover:text-primary-hover"
                >
                  Export manifest
                </Link>
              </div>
              {trace.evidence.length === 0 ? (
                <p className="mt-2 text-sm text-foreground-muted">No item-level evidence is attached.</p>
              ) : (
                <div className="mt-2 divide-y divide-border rounded-lg border border-border">
                  {trace.evidence.map((evidence, index) => {
                    const content = (
                      <div className="flex items-start justify-between gap-4 p-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-foreground">{evidence.label}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-foreground-muted">
                            <span className="rounded border border-border px-1.5 py-0.5">{SOURCE_LABELS[evidence.source]}</span>
                            <span>{evidence.kind}</span>
                            {evidence.observedAt && <span>{evidence.observedAt.slice(0, 10)}</span>}
                            {evidence.verified && <span className="text-positive">Verified</span>}
                            {evidence.stale && <span className="text-warning">Stale</span>}
                          </div>
                        </div>
                        {evidence.href && <span className="text-primary">↗</span>}
                      </div>
                    );
                    return evidence.href
                      ? <Link key={`${evidence.kind}:${evidence.id}:${index}`} href={evidence.href}>{content}</Link>
                      : <div key={`${evidence.kind}:${evidence.id}:${index}`}>{content}</div>;
                  })}
                </div>
              )}
            </section>

            {(trace.assumptions.length > 0 || trace.warnings.length > 0) && (
              <section className="grid gap-4 sm:grid-cols-2">
                {trace.assumptions.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">Assumptions</h4>
                    <ul className="mt-2 space-y-1 text-sm text-foreground-secondary">
                      {trace.assumptions.map(item => <li key={item}>• {item}</li>)}
                    </ul>
                  </div>
                )}
                {trace.warnings.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold text-warning">Warnings</h4>
                    <ul className="mt-2 space-y-1 text-sm text-foreground-secondary">
                      {trace.warnings.map(item => <li key={item}>• {item}</li>)}
                    </ul>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
