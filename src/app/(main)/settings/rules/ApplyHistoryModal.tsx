'use client';

/**
 * "Apply to history" modal for a categorization rule: pick a date range and
 * safety mode, preview the would-change transactions (dry run), then apply.
 * Backed by POST /api/settings/rules/apply-history (capped at 500 changes per
 * call; the moreRemain flag prompts the user to run again).
 */

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/contexts/ToastContext';

export interface ApplyHistoryRule {
  id: number;
  pattern: string;
  matchType: string;
  accountName: string | null;
}

interface MatchRow {
  guid: string;
  date: string;
  description: string;
  currentAccount: string;
  newAccount: string;
  amount: number;
}

interface SkipRow {
  guid: string;
  date: string;
  description: string;
  reason: string;
}

interface Preview {
  matchCount: number;
  skippedCount: number;
  moreRemain: boolean;
  matches: MatchRow[];
  skipped: SkipRow[];
}

interface ApplyHistoryModalProps {
  rule: ApplyHistoryRule | null;
  onClose: () => void;
}

/** Strip the root/book account name (first colon-delimited segment). */
function stripRoot(fullname: string | null): string {
  if (!fullname) return '(unknown account)';
  const idx = fullname.indexOf(':');
  return idx >= 0 ? fullname.slice(idx + 1) : fullname;
}

export default function ApplyHistoryModal({ rule, onClose }: ApplyHistoryModalProps) {
  const { success, error: showError } = useToast();

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [onlyUncategorized, setOnlyUncategorized] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ applied: number; moreRemain: boolean } | null>(null);

  // Reset all state whenever the modal opens for a (different) rule.
  useEffect(() => {
    setStartDate('');
    setEndDate('');
    setOnlyUncategorized(true);
    setPreview(null);
    setPreviewing(false);
    setApplying(false);
    setApplyResult(null);
  }, [rule?.id]);

  if (!rule) return null;

  const post = async (dryRun: boolean) => {
    const res = await fetch('/api/settings/rules/apply-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ruleId: rule.id,
        dryRun,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        onlyUncategorized,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  const runPreview = async () => {
    setPreviewing(true);
    setApplyResult(null);
    try {
      const data = await post(true);
      setPreview({
        matchCount: data.matchCount,
        skippedCount: data.skippedCount,
        moreRemain: data.moreRemain,
        matches: data.matches ?? [],
        skipped: data.skipped ?? [],
      });
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const runApply = async () => {
    if (!preview || preview.matchCount === 0) return;
    setApplying(true);
    try {
      const data = await post(false);
      setApplyResult({ applied: data.applied, moreRemain: data.moreRemain });
      setPreview(null);
      success(
        `Recategorized ${data.applied} transaction${data.applied !== 1 ? 's' : ''}` +
        (data.moreRemain ? ' — more remain, preview again' : ''),
      );
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Apply "${rule.pattern}" to history`} size="lg">
      <div className="p-4 space-y-4">
        <p className="text-xs text-foreground-secondary">
          Retroactively recategorizes past transactions whose description matches this rule
          ({rule.matchType}, case-insensitive) to <span className="text-foreground">{stripRoot(rule.accountName)}</span>.
          Preview first; changes are capped at 500 per run.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="block text-xs text-foreground-secondary" htmlFor="apply-start-date">From (optional)</label>
            <input
              id="apply-start-date"
              type="date"
              value={startDate}
              onChange={e => { setStartDate(e.target.value); setPreview(null); }}
              className="px-2 py-2 text-sm bg-background-tertiary border border-border rounded-md text-foreground focus:outline-none focus:border-border-hover"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-foreground-secondary" htmlFor="apply-end-date">To (optional)</label>
            <input
              id="apply-end-date"
              type="date"
              value={endDate}
              onChange={e => { setEndDate(e.target.value); setPreview(null); }}
              className="px-2 py-2 text-sm bg-background-tertiary border border-border rounded-md text-foreground focus:outline-none focus:border-border-hover"
            />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-foreground-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={onlyUncategorized}
              onChange={e => { setOnlyUncategorized(e.target.checked); setPreview(null); }}
              className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
            />
            Only uncategorized (Imbalance/Orphan)
          </label>
          <button
            onClick={() => void runPreview()}
            disabled={previewing || applying}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {previewing ? 'Previewing…' : 'Preview'}
          </button>
        </div>

        {!onlyUncategorized && (
          <p className="text-xs text-amber-500">
            Warning: this will also move splits already sitting on expense/income accounts.
          </p>
        )}

        {applyResult && (
          <div className="px-3 py-2 text-sm rounded border border-border bg-background-tertiary">
            Applied {applyResult.applied} change{applyResult.applied !== 1 ? 's' : ''}.
            {applyResult.moreRemain && ' More matches remain — run Preview again for the next batch.'}
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            <div className="text-sm text-foreground-secondary">
              {preview.matchCount} transaction{preview.matchCount !== 1 ? 's' : ''} would change
              {preview.skippedCount > 0 && `, ${preview.skippedCount} skipped`}
              {preview.moreRemain && ' (showing the first 500 — more remain)'}
            </div>

            {preview.matches.length > 0 && (
              <div className="border border-border rounded-md overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="text-left text-xs uppercase tracking-wider text-foreground-muted border-b border-border">
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Description</th>
                      <th className="px-3 py-2">Current Account</th>
                      <th className="px-3 py-2">New Account</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.matches.map(m => (
                      <tr key={m.guid} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-1.5 whitespace-nowrap font-mono text-foreground-secondary">{m.date}</td>
                        <td className="px-3 py-1.5 text-foreground">{m.description}</td>
                        <td className="px-3 py-1.5 text-foreground-secondary">{m.currentAccount}</td>
                        <td className="px-3 py-1.5 text-foreground-secondary">{m.newAccount}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-foreground-secondary">{m.amount.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.skipped.length > 0 && (
              <details className="text-xs text-foreground-secondary">
                <summary className="cursor-pointer">
                  {preview.skipped.length} skipped (ambiguous or unsafe)
                </summary>
                <ul className="mt-1 space-y-0.5 pl-4 list-disc">
                  {preview.skipped.slice(0, 20).map(s => (
                    <li key={s.guid}>
                      {s.date} — {s.description}: {s.reason}
                    </li>
                  ))}
                  {preview.skipped.length > 20 && <li>…and {preview.skipped.length - 20} more</li>}
                </ul>
              </details>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2 border-t border-border">
          <button
            onClick={onClose}
            disabled={applying}
            className="px-3 py-2 text-sm border border-border rounded-md text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            Close
          </button>
          <button
            onClick={() => void runApply()}
            disabled={!preview || preview.matchCount === 0 || applying || previewing}
            title={!preview ? 'Run Preview first' : undefined}
            className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {applying ? 'Applying…' : `Apply${preview ? ` ${preview.matchCount} change${preview.matchCount !== 1 ? 's' : ''}` : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
