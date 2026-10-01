'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { TNUM } from '@/components/ui/form';
import { formatCents } from '@/lib/expense-reports/model';
import type { ReportLineView } from './api';

export interface LineEdit {
  lineId: number;
  description?: string;
  businessPurpose?: string | null;
  expenseAccountGuid?: string | null;
}

interface Draft {
  description: string;
  purpose: string;
  account: string;
}

/** Editable columns (keyboard moves keep the column). */
type Col = 'description' | 'purpose' | 'account';

const CELL_INPUT =
  'w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-foreground hover:border-border focus:border-primary/50 focus:bg-input-bg focus:outline-none focus:ring-1 focus:ring-primary/20';

function draftOf(l: ReportLineView): Draft {
  return { description: l.description, purpose: l.businessPurpose ?? '', account: l.expenseAccountGuid ?? '' };
}

/**
 * Spreadsheet-style editor for a report's lines — the ledger's edit mode,
 * applied to expense report lines:
 *
 *  - every line's name, business purpose and expense account are typable
 *    in place (the account cell is the ledger's AccountSelector: type to
 *    filter, ↑/↓ + Enter to pick);
 *  - ↑/↓ (and Enter) move to the same column on the previous/next line, so
 *    "pick a category, ↓, pick the next one" works without the mouse;
 *  - checkboxes (shift-click for a range, header for all) select lines, and
 *    the bulk bar sets one category on all of them;
 *  - edits stay local until Save (or Ctrl/⌘+S), which sends one request.
 */
export function ReportLinesGrid({
  lines,
  mode,
  busy,
  onSave,
  onSplit,
  onDirtyChange,
}: {
  lines: ReportLineView[];
  /** categorize: report awaiting approval. recategorize: approved, unpaid (reposts). */
  mode: 'categorize' | 'recategorize' | 'readonly';
  busy: boolean;
  onSave: (edits: LineEdit[], rememberLineIds: number[]) => Promise<void>;
  onSplit?: (line: ReportLineView) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const editable = mode !== 'readonly';
  // Initialized from the saved lines; the parent remounts this grid (key)
  // when the saved lines change, which resets drafts and selection.
  const [draft, setDraft] = useState<Record<number, Draft>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, draftOf(l)])),
  );
  const [remember, setRemember] = useState<Set<number>>(new Set());
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const lastChecked = useRef<number | null>(null);
  const cells = useRef<Map<string, HTMLElement>>(new Map());

  const edits = useMemo<LineEdit[]>(() => {
    const out: LineEdit[] = [];
    for (const l of lines) {
      const d = draft[l.id];
      if (!d) continue;
      const e: LineEdit = { lineId: l.id };
      if (d.description !== l.description) e.description = d.description;
      if ((d.purpose || null) !== (l.businessPurpose ?? null)) e.businessPurpose = d.purpose || null;
      if ((d.account || null) !== (l.expenseAccountGuid ?? null)) e.expenseAccountGuid = d.account || null;
      if (Object.keys(e).length > 1) out.push(e);
    }
    return out;
  }, [draft, lines]);
  const dirty = edits.length > 0 || remember.size > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const set = (lineId: number, patch: Partial<Draft>) =>
    setDraft((cur) => ({ ...cur, [lineId]: { ...cur[lineId], ...patch } }));

  const focusCell = useCallback(
    (row: number, col: Col) => {
      if (row < 0 || row >= lines.length) return;
      const el = cells.current.get(`${row}:${col}`);
      const target = el instanceof HTMLInputElement ? el : el?.querySelector('input');
      target?.focus();
      target?.select?.();
    },
    [lines.length],
  );

  const save = useCallback(async () => {
    if (!dirty || busy) return;
    const invalid = edits.find((e) => e.description !== undefined && !e.description.trim());
    if (invalid) return;
    await onSave(edits, [...remember]);
  }, [busy, dirty, edits, onSave, remember]);

  const onTextKeyDown = (row: number, col: Col) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    } else if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      focusCell(row + 1, col);
    } else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) {
      e.preventDefault();
      focusCell(row - 1, col);
    } else if (e.key === 'Escape') {
      const l = lines[row];
      set(l.id, col === 'description' ? { description: l.description } : { purpose: l.businessPurpose ?? '' });
    }
  };

  const toggle = (row: number, shift: boolean) => {
    const id = lines[row].id;
    // Read the anchor NOW: React may run the updater after the assignment
    // below, which would collapse a shift-click range to a single row.
    const anchor = lastChecked.current;
    setChecked((cur) => {
      const next = new Set(cur);
      const on = !cur.has(id);
      if (shift && anchor !== null) {
        const [a, b] = [Math.min(anchor, row), Math.max(anchor, row)];
        for (let i = a; i <= b; i++) {
          if (on) next.add(lines[i].id);
          else next.delete(lines[i].id);
        }
      } else if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    lastChecked.current = row;
  };

  const allChecked = lines.length > 0 && checked.size === lines.length;
  const register = (row: number, col: Col) => (el: HTMLElement | null) => {
    const key = `${row}:${col}`;
    if (el) cells.current.set(key, el);
    else cells.current.delete(key);
  };

  return (
    <div
      className="space-y-2"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save();
        }
      }}
    >
      {editable && checked.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary-light px-3 py-2">
          <span className="text-xs font-medium text-foreground">
            {checked.size} selected · set category
          </span>
          <div className="min-w-[16rem] flex-1">
            <AccountSelector
              value=""
              compact
              accountTypes={['EXPENSE', 'ASSET']}
              placeholder="Type a category for the selected lines…"
              onChange={(guid) => {
                setDraft((cur) => {
                  const next = { ...cur };
                  for (const id of checked) next[id] = { ...next[id], account: guid };
                  return next;
                });
              }}
            />
          </div>
          <button
            type="button"
            className="text-xs text-foreground-secondary hover:text-foreground"
            onClick={() => setChecked(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-background-tertiary text-xs uppercase tracking-wider text-foreground-secondary">
            <tr>
              {editable && (
                <th className="w-8 px-2 py-1.5 text-left">
                  <input
                    type="checkbox"
                    aria-label="Select all lines"
                    checked={allChecked}
                    onChange={() => setChecked(allChecked ? new Set() : new Set(lines.map((l) => l.id)))}
                  />
                </th>
              )}
              <th className="px-2 py-1.5 text-left">Date</th>
              <th className="px-2 py-1.5 text-left">Line</th>
              <th className="px-2 py-1.5 text-left">Business purpose</th>
              <th className="px-2 py-1.5 text-right">Amount</th>
              <th className="min-w-[16rem] px-2 py-1.5 text-left">Expense account</th>
              {mode === 'categorize' && <th className="px-2 py-1.5" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.map((l, row) => {
              const d = draft[l.id] ?? draftOf(l);
              const changed = edits.some((e) => e.lineId === l.id);
              return (
                <tr key={l.id} className={checked.has(l.id) ? 'bg-primary-light' : changed ? 'bg-secondary-light' : undefined}>
                  {editable && (
                    <td className="px-2 py-1 align-middle">
                      <input
                        type="checkbox"
                        aria-label={`Select ${l.description}`}
                        checked={checked.has(l.id)}
                        onChange={() => undefined}
                        onClick={(e) => toggle(row, e.shiftKey)}
                      />
                    </td>
                  )}
                  <td className="whitespace-nowrap px-2 py-1 align-middle font-mono text-xs text-foreground-secondary" style={TNUM}>
                    {l.expenseDate}
                  </td>
                  <td className="min-w-[12rem] px-1 py-1 align-middle">
                    {editable ? (
                      <input
                        ref={register(row, 'description')}
                        aria-label={`Line name for ${l.description}`}
                        className={`${CELL_INPUT} ${!d.description.trim() ? 'border-error' : ''}`}
                        value={d.description}
                        onChange={(e) => set(l.id, { description: e.target.value })}
                        onKeyDown={onTextKeyDown(row, 'description')}
                      />
                    ) : (
                      <span className="px-2 text-xs text-foreground">{l.description}</span>
                    )}
                    <div className="px-2 text-[11px] text-foreground-muted">
                      {l.documentIds.length > 0 && `${l.documentIds.length} receipt${l.documentIds.length === 1 ? '' : 's'}`}
                      {l.accountablePlan && `${l.documentIds.length > 0 ? ' · ' : ''}accountable plan`}
                      {l.late && <span className="text-warning"> · past deadline</span>}
                    </div>
                  </td>
                  <td className="min-w-[10rem] px-1 py-1 align-middle">
                    {editable ? (
                      <input
                        ref={register(row, 'purpose')}
                        aria-label={`Business purpose for ${l.description}`}
                        className={CELL_INPUT}
                        placeholder="—"
                        value={d.purpose}
                        onChange={(e) => set(l.id, { purpose: e.target.value })}
                        onKeyDown={onTextKeyDown(row, 'purpose')}
                      />
                    ) : (
                      <span className="px-2 text-xs text-foreground-secondary">{l.businessPurpose ?? ''}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right align-middle font-mono" style={TNUM}>
                    {formatCents(l.amountCents)}
                  </td>
                  <td className="px-1 py-1 align-middle">
                    {editable ? (
                      <div ref={register(row, 'account')} aria-label={`Expense account for ${l.description}`}>
                        <AccountSelector
                          value={d.account}
                          compact
                          accountTypes={['EXPENSE', 'ASSET']}
                          placeholder={mode === 'recategorize' ? 'Keep current' : 'Uncategorized — type to pick'}
                          onChange={(guid) => set(l.id, { account: guid })}
                          onArrowDown={() => focusCell(row + 1, 'account')}
                          onEnter={() => focusCell(row + 1, 'account')}
                          onArrowUp={() => focusCell(row - 1, 'account')}
                        />
                        <div className="flex items-center gap-2 px-2 text-[11px] text-foreground-muted">
                          <span>{d.account === (l.expenseAccountGuid ?? '') ? l.categorizedByLabel : 'Edited'}</span>
                          {mode === 'categorize' && d.account && (
                            <label className="flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={remember.has(l.id)}
                                onChange={() =>
                                  setRemember((cur) => {
                                    const next = new Set(cur);
                                    if (next.has(l.id)) next.delete(l.id);
                                    else next.add(l.id);
                                    return next;
                                  })
                                }
                              />
                              Remember for this payee
                            </label>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="px-2 text-xs text-foreground-secondary">{l.expenseAccountName ?? 'Uncategorized'}</span>
                    )}
                  </td>
                  {mode === 'categorize' && (
                    <td className="px-2 py-1 text-right align-middle">
                      <button
                        type="button"
                        className="text-xs text-foreground-secondary hover:text-foreground"
                        onClick={() => onSplit?.(l)}
                      >
                        Split…
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-muted">
          <span>
            Type to pick a category · ↑/↓ or Enter moves between lines · shift-click checkboxes for a range ·
            Ctrl/⌘+S saves
          </span>
          {dirty && (
            <span className="flex gap-2">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-hover"
                onClick={() => {
                  setDraft(Object.fromEntries(lines.map((l) => [l.id, draftOf(l)])));
                  setRemember(new Set());
                }}
              >
                Discard
              </button>
              <button
                type="button"
                disabled={busy || edits.some((e) => e.description !== undefined && !e.description.trim())}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                onClick={() => void save()}
              >
                {mode === 'recategorize' ? 'Save & repost voucher' : `Save ${edits.length || ''} change${edits.length === 1 ? '' : 's'}`}
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
