'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { Modal } from '@/components/ui/Modal';
import { INPUT, LABEL, SELECT, TNUM } from '@/components/ui/form';
import { formatCents } from '@/lib/expense-reports/model';
import {
  api,
  loadAccounts,
  type AccountOption,
  type Candidate,
  type LinkOverview,
  type RewritePreview,
  type SubmitLinePreview,
} from './api';

interface Selection {
  cents: string; // dollars as typed
  purpose: string;
}

function dollarsToCents(value: string): number {
  const n = Number(value.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function PreviewTable({ preview, accounts }: { preview: RewritePreview; accounts: Map<string, string> }) {
  const name = (g: string) => accounts.get(g) ?? g.slice(0, 8);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {(['before', 'after'] as const).map((side) => (
        <div key={side} className="rounded-md border border-border p-2">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground-secondary">{side}</div>
          <table className="w-full text-xs">
            <tbody>
              {preview[side].map((s, i) => (
                <tr key={i}>
                  <td className="py-0.5 pr-2 text-foreground">{name(s.accountGuid)}</td>
                  <td className="py-0.5 text-right font-mono" style={TNUM}>{formatCents(s.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/** Household side: report charges to a linked business. */
export function HouseholdView({ link, canEdit, onChanged }: { link: LinkOverview; canEdit: boolean; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [unreported, setUnreported] = useState(0);
  const [selected, setSelected] = useState<Record<string, Selection>>({});
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [review, setReview] = useState<{ lines: SubmitLinePreview[]; totalCents: number } | null>(null);
  const [title, setTitle] = useState('');
  const [personal, setPersonal] = useState<{ candidate: Candidate; amount: string; accountGuid: string; preview: RewritePreview | null } | null>(null);
  const [markOpen, setMarkOpen] = useState(false);
  const [markSearch, setMarkSearch] = useState('');
  const [markable, setMarkable] = useState<Array<{ splitGuid: string; date: string; description: string; accountName: string; valueCents: number }>>([]);
  const [markPreview, setMarkPreview] = useState<{ splitGuid: string; preview: RewritePreview } | null>(null);
  const [busy, setBusy] = useState(false);

  const configured = Boolean(link.settings.reimbursableAccountGuid);
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.guid, a.path])), [accounts]);

  const load = useCallback(async () => {
    if (!configured) {
      setCandidates([]);
      return;
    }
    try {
      const data = await api<{ candidates: Candidate[]; unreportedCents: number }>(
        `/api/expense-reports/charges?business=${link.businessBookGuid}`,
      );
      setCandidates(data.candidates);
      setUnreported(data.unreportedCents);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to load charges');
      setCandidates([]);
    }
  }, [configured, link.businessBookGuid, showError]);

  useEffect(() => {
    load();
    loadAccounts(link.householdBookGuid, ['EXPENSE', 'RECEIVABLE', 'ASSET', 'CREDIT', 'BANK', 'LIABILITY'])
      .then(setAccounts)
      .catch(() => undefined);
  }, [load, link.householdBookGuid]);

  const selectedLines = Object.entries(selected);
  const selectedTotal = selectedLines.reduce((s, [, v]) => s + (dollarsToCents(v.cents) || 0), 0);

  const toggle = (c: Candidate) =>
    setSelected((cur) => {
      const next = { ...cur };
      if (next[c.splitGuid]) delete next[c.splitGuid];
      else next[c.splitGuid] = { cents: (c.remainderCents / 100).toFixed(2), purpose: '' };
      return next;
    });

  const toggleAll = () =>
    setSelected((cur) =>
      candidates && Object.keys(cur).length < candidates.length
        ? Object.fromEntries(candidates.map((c) => [c.splitGuid, cur[c.splitGuid] ?? { cents: (c.remainderCents / 100).toFixed(2), purpose: '' }]))
        : {},
    );

  const linesBody = () =>
    selectedLines.map(([splitGuid, v]) => ({ splitGuid, cents: dollarsToCents(v.cents), businessPurpose: v.purpose || null }));

  const startReview = async () => {
    setBusy(true);
    try {
      const data = await api<{ lines: SubmitLinePreview[]; totalCents: number }>('/api/expense-reports', {
        json: { businessBookGuid: link.businessBookGuid, lines: linesBody(), dryRun: true },
      });
      setReview(data);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not review the report');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const data = await api<{ report: { label: string } }>('/api/expense-reports', {
        json: { businessBookGuid: link.businessBookGuid, lines: linesBody(), title: title || null },
      });
      success(`Submitted ${data.report.label} to ${link.businessName}`);
      setReview(null);
      setSelected({});
      setTitle('');
      await load();
      onChanged();
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not submit the report');
    } finally {
      setBusy(false);
    }
  };

  const previewPersonal = async () => {
    if (!personal) return;
    setBusy(true);
    try {
      const preview = await api<RewritePreview>('/api/expense-reports/charges', {
        json: {
          businessBookGuid: link.businessBookGuid,
          action: 'personal',
          splitGuid: personal.candidate.splitGuid,
          cents: dollarsToCents(personal.amount),
          personalAccountGuid: personal.accountGuid,
          dryRun: true,
        },
      });
      setPersonal({ ...personal, preview });
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not preview');
    } finally {
      setBusy(false);
    }
  };

  const applyPersonal = async () => {
    if (!personal) return;
    setBusy(true);
    try {
      await api('/api/expense-reports/charges', {
        json: {
          businessBookGuid: link.businessBookGuid,
          action: 'personal',
          splitGuid: personal.candidate.splitGuid,
          cents: dollarsToCents(personal.amount),
          personalAccountGuid: personal.accountGuid,
        },
      });
      success('Personal part moved off the reimbursable account');
      setPersonal(null);
      setSelected((cur) => {
        const next = { ...cur };
        delete next[personal.candidate.splitGuid];
        return next;
      });
      await load();
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not update the charge');
    } finally {
      setBusy(false);
    }
  };

  const searchMarkable = async () => {
    try {
      const data = await api<{ charges: typeof markable }>(
        `/api/expense-reports/charges?business=${link.businessBookGuid}&view=markable&search=${encodeURIComponent(markSearch)}`,
      );
      setMarkable(data.charges);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Search failed');
    }
  };

  const mark = async (splitGuid: string, dryRun: boolean) => {
    setBusy(true);
    try {
      const preview = await api<RewritePreview>('/api/expense-reports/charges', {
        json: { businessBookGuid: link.businessBookGuid, action: 'mark', splitGuid, dryRun },
      });
      if (dryRun) {
        setMarkPreview({ splitGuid, preview });
      } else {
        success('Charge moved to the reimbursable account');
        setMarkPreview(null);
        setMarkable((list) => list.filter((m) => m.splitGuid !== splitGuid));
        await load();
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not mark the charge');
    } finally {
      setBusy(false);
    }
  };

  if (!configured) {
    return (
      <p className="rounded-lg border border-border p-4 text-sm text-foreground-secondary">
        Choose the reimbursable account in Setup above to start reporting charges to {link.businessName}.
      </p>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Charges to report to {link.businessName}</h2>
          <p className="text-sm text-foreground-muted">
            <span className="font-mono text-foreground" style={TNUM}>{formatCents(unreported)}</span> unreported on the
            reimbursable account. Pick charges (or part of one) and submit them as an expense report.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => setMarkOpen(true)}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface-hover"
          >
            Mark charges for reimbursement…
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-background-tertiary text-xs uppercase tracking-wider text-foreground-secondary">
            <tr>
              <th className="px-2 py-2 text-left">
                <input
                  type="checkbox"
                  aria-label="Select all charges"
                  checked={!!candidates?.length && selectedLines.length === candidates.length}
                  onChange={toggleAll}
                  disabled={!canEdit}
                />
              </th>
              <th className="px-2 py-2 text-left">Date</th>
              <th className="px-2 py-2 text-left">Charge</th>
              <th className="px-2 py-2 text-right">Left to report</th>
              <th className="px-2 py-2 text-right">Include</th>
              <th className="px-2 py-2 text-left">Business purpose</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {candidates === null && (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-foreground-muted">Loading…</td>
              </tr>
            )}
            {candidates?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-4 text-center text-foreground-muted">
                  Nothing left to report. Everything on the reimbursable account is on a report.
                </td>
              </tr>
            )}
            {candidates?.map((c) => {
              const sel = selected[c.splitGuid];
              return (
                <tr key={c.splitGuid} className={sel ? 'bg-primary-light' : undefined}>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.description}`}
                      checked={!!sel}
                      onChange={() => toggle(c)}
                      disabled={!canEdit}
                    />
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs text-foreground-secondary" style={TNUM}>{c.date}</td>
                  <td className="px-2 py-1.5">
                    <div className="text-foreground">{c.description}</div>
                    <div className="text-xs text-foreground-muted">
                      {c.paidFrom ?? '—'}
                      {c.documentCount > 0 && ` · ${c.documentCount} receipt${c.documentCount === 1 ? '' : 's'}`}
                      {c.badge && ` · ${c.badge}`}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono" style={TNUM}>
                    {formatCents(c.remainderCents)}
                    {c.remainderCents !== c.valueCents && (
                      <div className="text-xs text-foreground-muted">of {formatCents(c.valueCents)}</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {sel && (
                      <input
                        aria-label={`Amount to report for ${c.description}`}
                        className={`${INPUT} w-24 text-right font-mono`}
                        value={sel.cents}
                        onChange={(e) => setSelected({ ...selected, [c.splitGuid]: { ...sel, cents: e.target.value } })}
                      />
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {sel && (
                      <input
                        aria-label={`Business purpose for ${c.description}`}
                        className={INPUT}
                        placeholder="Optional unless the business is a corporation"
                        value={sel.purpose}
                        onChange={(e) => setSelected({ ...selected, [c.splitGuid]: { ...sel, purpose: e.target.value } })}
                      />
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {canEdit && (
                      <button
                        type="button"
                        className="text-xs text-foreground-secondary hover:text-foreground"
                        onClick={() => setPersonal({ candidate: c, amount: '', accountGuid: '', preview: null })}
                      >
                        Personal part…
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canEdit && selectedLines.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary-light p-3">
          <span className="text-sm text-foreground">
            {selectedLines.length} charge{selectedLines.length === 1 ? '' : 's'} ·{' '}
            <span className="font-mono" style={TNUM}>{formatCents(selectedTotal)}</span>
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={startReview}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            Review report…
          </button>
        </div>
      )}

      <Modal isOpen={review !== null} onClose={() => setReview(null)} title={`Expense report to ${link.businessName}`} size="xl">
        {review && (
          <div className="space-y-3 p-4">
            <label className="block">
              <span className={LABEL}>Title (optional)</span>
              <input className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="September supplies" />
            </label>
            <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-background-tertiary text-xs uppercase tracking-wider text-foreground-secondary">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Date</th>
                    <th className="px-2 py-1.5 text-left">Charge</th>
                    <th className="px-2 py-1.5 text-right">Amount</th>
                    <th className="px-2 py-1.5 text-left">Tax status that day</th>
                    <th className="px-2 py-1.5 text-left">Evidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {review.lines.map((l, i) => (
                    <tr key={`${l.splitGuid}-${i}`}>
                      <td className="px-2 py-1 font-mono text-xs" style={TNUM}>{l.date}</td>
                      <td className="px-2 py-1">{l.description}</td>
                      <td className="px-2 py-1 text-right font-mono" style={TNUM}>{formatCents(l.amountCents)}</td>
                      <td className="px-2 py-1 text-xs text-foreground-secondary">
                        {l.accountablePlan ? 'Corporation — accountable plan' : 'Disregarded / pass-through'}
                      </td>
                      <td className="px-2 py-1 text-xs">
                        {l.missing.length > 0 ? (
                          <span className="text-error">Needs {l.missing.map((m) => (m === 'receipt' ? 'a receipt' : 'a business purpose')).join(' and ')}</span>
                        ) : l.late ? (
                          <span className="text-warning">Past the deadline</span>
                        ) : (
                          <span className="text-foreground-muted">{l.documentIds.length > 0 ? `${l.documentIds.length} receipt(s)` : 'OK'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-foreground-muted">
              {link.businessName} categorizes each line to its own chart of accounts before approving.
              {review.lines.some((l) => l.suggestion) &&
                ` ${review.lines.filter((l) => l.suggestion).length} line(s) will arrive pre-categorized by its rules and payee history.`}
            </p>
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm" style={TNUM}>Total {formatCents(review.totalCents)}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setReview(null)} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-hover">
                  Back
                </button>
                <button
                  type="button"
                  disabled={busy || review.lines.some((l) => l.missing.length > 0)}
                  onClick={submit}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                >
                  {busy ? 'Submitting…' : 'Submit report'}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={personal !== null} onClose={() => setPersonal(null)} title="Split off a personal part" size="lg">
        {personal && (
          <div className="space-y-3 p-4">
            <p className="text-sm text-foreground">
              {personal.candidate.description} · {formatCents(personal.candidate.remainderCents)} left to report. The
              personal part moves off the reimbursable account to a household expense account.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>Personal amount</span>
                <input
                  className={`${INPUT} font-mono`}
                  value={personal.amount}
                  onChange={(e) => setPersonal({ ...personal, amount: e.target.value, preview: null })}
                  placeholder="22.22"
                />
              </label>
              <label className="block">
                <span className={LABEL}>Household expense account</span>
                <select
                  className={SELECT}
                  value={personal.accountGuid}
                  onChange={(e) => setPersonal({ ...personal, accountGuid: e.target.value, preview: null })}
                >
                  <option value="">Choose…</option>
                  {accounts.filter((a) => a.type === 'EXPENSE').map((a) => (
                    <option key={a.guid} value={a.guid}>{a.path}</option>
                  ))}
                </select>
              </label>
            </div>
            {personal.preview && <PreviewTable preview={personal.preview} accounts={accountNames} />}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setPersonal(null)} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-hover">
                Cancel
              </button>
              {personal.preview ? (
                <button type="button" disabled={busy} onClick={applyPersonal} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50">
                  Rewrite transaction
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || !personal.accountGuid || !(dollarsToCents(personal.amount) > 0)}
                  onClick={previewPersonal}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                >
                  Preview
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={markOpen} onClose={() => { setMarkOpen(false); setMarkPreview(null); }} title="Mark charges for reimbursement" size="xl">
        <div className="space-y-3 p-4">
          <p className="text-sm text-foreground-muted">
            Recent household expense charges. Marking one moves it onto the reimbursable account so it can be reported.
          </p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              searchMarkable();
            }}
          >
            <input className={INPUT} placeholder="Search descriptions" value={markSearch} onChange={(e) => setMarkSearch(e.target.value)} />
            <button type="submit" className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface-hover">
              Search
            </button>
          </form>
          {markPreview && (
            <div className="space-y-2 rounded-md border border-primary/40 p-3">
              <PreviewTable preview={markPreview.preview} accounts={accountNames} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setMarkPreview(null)} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary">
                  Cancel
                </button>
                <button type="button" disabled={busy} onClick={() => mark(markPreview.splitGuid, false)} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  Move to reimbursable
                </button>
              </div>
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {markable.map((m) => (
                  <tr key={m.splitGuid}>
                    <td className="px-2 py-1 font-mono text-xs" style={TNUM}>{m.date}</td>
                    <td className="px-2 py-1">
                      {m.description}
                      <div className="text-xs text-foreground-muted">{m.accountName}</div>
                    </td>
                    <td className="px-2 py-1 text-right font-mono" style={TNUM}>{formatCents(m.valueCents)}</td>
                    <td className="px-2 py-1 text-right">
                      <button type="button" disabled={busy} className="text-xs text-primary hover:underline" onClick={() => mark(m.splitGuid, true)}>
                        Mark…
                      </button>
                    </td>
                  </tr>
                ))}
                {markable.length === 0 && (
                  <tr>
                    <td className="px-2 py-3 text-center text-foreground-muted">Search to find charges.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>
    </section>
  );
}
