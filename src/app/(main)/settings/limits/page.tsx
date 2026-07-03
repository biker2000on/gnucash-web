'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileCard } from '@/components/ui/MobileCard';

const EARLIEST_YEAR = 2024;

const TYPE_LABELS: Record<string, string> = {
  '401k': '401(k)',
  '403b': '403(b)',
  '457': '457(b)',
  traditional_ira: 'Traditional IRA',
  roth_ira: 'Roth IRA',
  sep_ira: 'SEP IRA',
  simple_ira: 'SIMPLE IRA',
  hsa: 'HSA',
  hra: 'HRA',
  fsa: 'FSA',
  education_529: '529 Plan',
  coverdell_esa: 'Coverdell ESA',
  brokerage: 'Brokerage',
};

function typeLabel(t: string): string {
  return TYPE_LABELS[t] || t;
}

interface ApiLimit {
  account_type: string;
  base_limit: number;
  catch_up_limit: number;
  catch_up_age: number;
  isOverride: boolean;
}

type RowSource = 'default' | 'override' | 'draft';

interface EditableLimitRow {
  account_type: string;
  base: string;
  catchUp: string;
  catchUpAge: string;
  source: RowSource;
  original: { base: string; catchUp: string; catchUpAge: string } | null; // null = draft, nothing saved yet
  saving: boolean;
}

interface AiFetchedLimit {
  account_type: string;
  base: number | null;
  catchUp: number | null;
  catchUpAge: number | null;
  source: string | null;
}

interface AiPreview {
  year: number;
  fetched: AiFetchedLimit[];
  model: string | null;
}

function toEditableRow(l: ApiLimit): EditableLimitRow {
  const snapshot = {
    base: String(l.base_limit),
    catchUp: String(l.catch_up_limit),
    catchUpAge: String(l.catch_up_age),
  };
  return {
    account_type: l.account_type,
    ...snapshot,
    source: l.isOverride ? 'override' : 'default',
    original: snapshot,
    saving: false,
  };
}

function isDirty(row: EditableLimitRow): boolean {
  if (!row.original) return true; // drafts are unsaved by definition
  return (
    row.base !== row.original.base ||
    row.catchUp !== row.original.catchUp ||
    row.catchUpAge !== row.original.catchUpAge
  );
}

function sourceBadge(source: RowSource, dirty: boolean) {
  if (source === 'draft') {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-warning/15 text-warning font-medium">Draft</span>;
  }
  if (source === 'override') {
    return <span className="text-xs px-1.5 py-0.5 rounded bg-secondary-light text-secondary font-medium">Override</span>;
  }
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-background-tertiary text-foreground-muted font-medium">
      Default{dirty ? ' *' : ''}
    </span>
  );
}

const fmtUsd = (n: number) => `$${n.toLocaleString('en-US')}`;

export default function ContributionLimitsPage() {
  const { success, error: showError } = useToast();
  const isMobile = useIsMobile();

  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [extraYears, setExtraYears] = useState<number[]>([]);
  const [rows, setRows] = useState<EditableLimitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftYear, setDraftYear] = useState(false);
  const [addYearValue, setAddYearValue] = useState(String(currentYear + 1));
  const [addingYear, setAddingYear] = useState(false);

  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiPreview, setAiPreview] = useState<AiPreview | null>(null);
  const [aiApplying, setAiApplying] = useState(false);

  // When addYear seeds a draft, the year-change effect must not reload (and
  // wipe) the draft rows. Set to the draft year to skip the next auto-load.
  const skipNextLoadRef = useRef<number | null>(null);

  const years = useMemo(() => {
    const set = new Set<number>(extraYears);
    for (let y = EARLIEST_YEAR; y <= currentYear + 1; y++) set.add(y);
    set.add(year);
    return [...set].sort((a, b) => b - a);
  }, [extraYears, currentYear, year]);

  const fetchLimitsForYear = useCallback(async (y: number): Promise<ApiLimit[]> => {
    const res = await fetch(`/api/contribution-limits?year=${y}`);
    if (!res.ok) throw new Error('Failed to load contribution limits');
    const data = await res.json();
    return data.limits || [];
  }, []);

  const loadYear = useCallback(async (y: number) => {
    setLoading(true);
    setAiPreview(null);
    try {
      const limits = await fetchLimitsForYear(y);
      setRows(limits.map(toEditableRow));
      setDraftYear(false);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to load limits');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [fetchLimitsForYear, showError]);

  useEffect(() => {
    if (skipNextLoadRef.current === year) {
      skipNextLoadRef.current = null;
      return;
    }
    void loadYear(year);
  }, [year, loadYear]);

  useEffect(() => {
    fetch('/api/contribution-limits/ai-fetch')
      .then(res => (res.ok ? res.json() : { configured: false }))
      .then(data => setAiConfigured(!!data.configured))
      .catch(() => setAiConfigured(false));
  }, []);

  const updateRow = (accountType: string, patch: Partial<EditableLimitRow>) => {
    setRows(prev => prev.map(r => (r.account_type === accountType ? { ...r, ...patch } : r)));
  };

  const saveRow = async (row: EditableLimitRow, opts?: { silent?: boolean; notes?: string }) => {
    const base = Number(row.base);
    const catchUp = Number(row.catchUp || '0');
    const catchUpAge = Number(row.catchUpAge || '50');
    if (!isFinite(base) || base < 0 || !isFinite(catchUp) || catchUp < 0 || !isFinite(catchUpAge) || catchUpAge < 0) {
      showError(`${typeLabel(row.account_type)}: values must be non-negative numbers`);
      return false;
    }

    updateRow(row.account_type, { saving: true });
    try {
      const res = await fetch('/api/contribution-limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tax_year: year,
          account_type: row.account_type,
          base_limit: base,
          catch_up_limit: catchUp,
          catch_up_age: catchUpAge,
          ...(opts?.notes ? { notes: opts.notes } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save limit');

      const snapshot = { base: String(base), catchUp: String(catchUp), catchUpAge: String(catchUpAge) };
      updateRow(row.account_type, { ...snapshot, source: 'override', original: snapshot, saving: false });
      if (!opts?.silent) success(`${typeLabel(row.account_type)} limit saved for ${year}`);
      return true;
    } catch (err) {
      updateRow(row.account_type, { saving: false });
      if (!opts?.silent) showError(err instanceof Error ? err.message : 'Failed to save limit');
      return false;
    }
  };

  const saveAllDirty = async () => {
    const dirty = rows.filter(isDirty);
    let saved = 0;
    for (const row of dirty) {
      if (await saveRow(row, { silent: true })) saved++;
    }
    if (saved > 0) success(`Saved ${saved} limit${saved === 1 ? '' : 's'} for ${year}`);
    if (saved < dirty.length) showError(`${dirty.length - saved} row(s) failed to save`);
    setDraftYear(false);
  };

  const removeOverride = async (row: EditableLimitRow) => {
    updateRow(row.account_type, { saving: true });
    try {
      const res = await fetch(
        `/api/contribution-limits?year=${year}&account_type=${encodeURIComponent(row.account_type)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove override');
      setRows((data.limits as ApiLimit[]).map(toEditableRow));
      success(`${typeLabel(row.account_type)} override removed for ${year}`);
    } catch (err) {
      updateRow(row.account_type, { saving: false });
      showError(err instanceof Error ? err.message : 'Failed to remove override');
    }
  };

  const addYear = async () => {
    const y = parseInt(addYearValue, 10);
    if (isNaN(y) || y < 2000 || y > 2100) {
      showError('Enter a year between 2000 and 2100');
      return;
    }
    setAddingYear(true);
    try {
      const existing = await fetchLimitsForYear(y);
      setExtraYears(prev => (prev.includes(y) ? prev : [...prev, y]));
      if (existing.length > 0) {
        setYear(y);
        return;
      }
      // Copy the nearest year that has data as a starting draft
      const candidates = years
        .filter(c => c !== y)
        .sort((a, b) => Math.abs(a - y) - Math.abs(b - y) || b - a);
      let basis: ApiLimit[] = [];
      let basisYear: number | null = null;
      for (const c of candidates) {
        const limits = await fetchLimitsForYear(c);
        if (limits.length > 0) {
          basis = limits;
          basisYear = c;
          break;
        }
      }
      skipNextLoadRef.current = y;
      setYear(y);
      setLoading(false);
      setAiPreview(null);
      setDraftYear(true);
      setRows(basis.map(l => ({
        account_type: l.account_type,
        base: String(l.base_limit),
        catchUp: String(l.catch_up_limit),
        catchUpAge: String(l.catch_up_age),
        source: 'draft' as RowSource,
        original: null,
        saving: false,
      })));
      if (basisYear !== null) {
        success(`Draft for ${y} started from ${basisYear} values — review and save`);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to add year');
    } finally {
      setAddingYear(false);
    }
  };

  const fetchWithAi = async () => {
    setAiLoading(true);
    setAiPreview(null);
    try {
      const res = await fetch('/api/contribution-limits/ai-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI fetch failed');
      setAiPreview({ year: data.year, fetched: data.fetched || [], model: data.model || null });
      if (!data.fetched || data.fetched.length === 0) {
        showError('AI returned no usable limit data for this year');
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : 'AI fetch failed');
    } finally {
      setAiLoading(false);
    }
  };

  const applyAiPreview = async () => {
    if (!aiPreview) return;
    const applicable = aiPreview.fetched.filter(f => f.base !== null);
    setAiApplying(true);
    try {
      let saved = 0;
      for (const f of applicable) {
        const res = await fetch('/api/contribution-limits', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tax_year: aiPreview.year,
            account_type: f.account_type,
            base_limit: f.base,
            catch_up_limit: f.catchUp ?? 0,
            catch_up_age: f.catchUpAge ?? 50,
            notes: `AI-suggested${f.source ? ` (${f.source})` : ''}, user-confirmed`,
          }),
        });
        if (res.ok) saved++;
      }
      success(`Applied ${saved} AI-suggested limit${saved === 1 ? '' : 's'} for ${aiPreview.year}`);
      setAiPreview(null);
      await loadYear(year);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to apply AI values');
    } finally {
      setAiApplying(false);
    }
  };

  const currentByType = useMemo(() => {
    const map = new Map<string, EditableLimitRow>();
    for (const r of rows) map.set(r.account_type, r);
    return map;
  }, [rows]);

  const dirtyCount = rows.filter(isDirty).length;

  const numberInput = (row: EditableLimitRow, field: 'base' | 'catchUp' | 'catchUpAge', width: string) => (
    <input
      type="number"
      min={0}
      value={row[field]}
      onChange={e => updateRow(row.account_type, { [field]: e.target.value })}
      className={`${width} px-2 py-1 text-sm font-mono text-right bg-background-tertiary border border-border rounded focus:outline-none focus:border-border-hover`}
      disabled={row.saving}
    />
  );

  const rowActions = (row: EditableLimitRow) => (
    <div className="flex items-center gap-2 justify-end">
      {isDirty(row) && (
        <button
          onClick={() => void saveRow(row)}
          disabled={row.saving}
          className="px-2 py-1 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary-hover transition-colors disabled:opacity-50"
        >
          {row.saving ? 'Saving…' : 'Save'}
        </button>
      )}
      {row.source === 'override' && !isDirty(row) && (
        <button
          onClick={() => void removeOverride(row)}
          disabled={row.saving}
          className="px-2 py-1 text-xs text-foreground-secondary hover:text-foreground hover:bg-surface-hover rounded transition-colors disabled:opacity-50"
          title="Remove the DB override; the code default (if any) applies again"
        >
          Remove override
        </button>
      )}
    </div>
  );

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Contribution Limits</h1>
        <p className="text-sm text-foreground-secondary mt-1">
          IRS contribution limits per tax year. Values come from built-in defaults; edits are stored as
          overrides in the database and take precedence.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="text-sm text-foreground-secondary" htmlFor="limit-year">Tax year</label>
        <select
          id="limit-year"
          value={year}
          onChange={e => setYear(parseInt(e.target.value, 10))}
          className="px-2 py-1.5 text-sm bg-surface border border-border rounded focus:outline-none focus:border-border-hover"
        >
          {years.map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>

        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={addYearValue}
            onChange={e => setAddYearValue(e.target.value)}
            className="w-20 px-2 py-1.5 text-sm font-mono bg-surface border border-border rounded focus:outline-none focus:border-border-hover"
            aria-label="Year to add"
          />
          <button
            onClick={() => void addYear()}
            disabled={addingYear}
            className="px-3 py-1.5 text-sm border border-border rounded text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {addingYear ? 'Adding…' : 'Add year'}
          </button>
        </div>

        <div className="flex-1" />

        {dirtyCount > 1 && (
          <button
            onClick={() => void saveAllDirty()}
            className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-primary-hover transition-colors"
          >
            Save all ({dirtyCount})
          </button>
        )}

        <button
          onClick={() => void fetchWithAi()}
          disabled={!aiConfigured || aiLoading}
          title={aiConfigured ? 'Ask the configured AI provider for published IRS limits (preview before saving)' : 'Configure an AI provider under Settings → AI to enable'}
          className="px-3 py-1.5 text-sm border border-border rounded text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {aiLoading ? 'Fetching…' : 'Fetch with AI'}
        </button>
      </div>

      {draftYear && (
        <div className="mb-4 px-3 py-2 text-sm rounded border border-warning/40 bg-warning/10 text-warning">
          Draft: these values were copied from the nearest configured year and are <strong>not saved</strong>.
          Verify against the published IRS numbers, then save each row (or Save all).
        </div>
      )}

      {/* AI preview diff */}
      {aiPreview && (
        <div className="mb-6 border border-secondary/40 rounded-md bg-surface">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">
              AI-suggested limits for {aiPreview.year}
              {aiPreview.model && <span className="font-normal text-foreground-muted"> · {aiPreview.model}</span>}
            </h2>
            <p className="text-xs text-foreground-secondary mt-1">
              Preview only — nothing is saved until you click Apply. Verify against the cited IRS
              Revenue Procedure / Notice before applying. Unknown values are shown as “—” and are never saved.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-foreground-muted border-b border-border">
                  <th className="px-4 py-2">Account Type</th>
                  <th className="px-4 py-2 text-right">Base (current → AI)</th>
                  <th className="px-4 py-2 text-right">Catch-Up (current → AI)</th>
                  <th className="px-4 py-2 text-right">Age</th>
                  <th className="px-4 py-2">Cited Source</th>
                </tr>
              </thead>
              <tbody>
                {aiPreview.fetched.map(f => {
                  const cur = currentByType.get(f.account_type);
                  const curBase = cur ? Number(cur.base) : null;
                  const curCatchUp = cur ? Number(cur.catchUp) : null;
                  const baseChanged = f.base !== null && f.base !== curBase;
                  const catchUpChanged = f.catchUp !== null && f.catchUp !== curCatchUp;
                  return (
                    <tr key={f.account_type} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-2 text-foreground">{typeLabel(f.account_type)}</td>
                      <td className="px-4 py-2 text-right font-mono">
                        <span className="text-foreground-muted">{curBase !== null ? fmtUsd(curBase) : '—'}</span>
                        <span className="text-foreground-muted"> → </span>
                        <span className={baseChanged ? 'text-warning font-medium' : 'text-foreground'}>
                          {f.base !== null ? fmtUsd(f.base) : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        <span className="text-foreground-muted">{curCatchUp !== null ? fmtUsd(curCatchUp) : '—'}</span>
                        <span className="text-foreground-muted"> → </span>
                        <span className={catchUpChanged ? 'text-warning font-medium' : 'text-foreground'}>
                          {f.catchUp !== null ? fmtUsd(f.catchUp) : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-foreground">
                        {f.catchUpAge !== null ? f.catchUpAge : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-foreground-secondary">{f.source || 'not cited'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-border flex items-center gap-3">
            <button
              onClick={() => void applyAiPreview()}
              disabled={aiApplying || aiPreview.fetched.every(f => f.base === null)}
              className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              {aiApplying ? 'Applying…' : `Apply ${aiPreview.fetched.filter(f => f.base !== null).length} value(s)`}
            </button>
            <button
              onClick={() => setAiPreview(null)}
              disabled={aiApplying}
              className="px-3 py-1.5 text-sm border border-border rounded text-foreground-secondary hover:text-foreground hover:bg-surface-hover transition-colors"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Limits table / cards */}
      {loading ? (
        <div className="py-12 text-center text-sm text-foreground-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-foreground-muted border border-border rounded-md bg-surface">
          No limits configured for {year}. Use “Add year” to start from the nearest configured year
          {aiConfigured ? ', or “Fetch with AI” to look up published values.' : '.'}
        </div>
      ) : isMobile ? (
        <div className="border border-border rounded-md bg-surface">
          {rows.map(row => (
            <MobileCard
              key={row.account_type}
              fields={[
                { label: 'Account', value: <span className="font-medium">{typeLabel(row.account_type)}</span> },
                { label: 'Source', value: sourceBadge(row.source, isDirty(row)) },
                { label: 'Base', value: numberInput(row, 'base', 'w-28') },
                { label: 'Catch-Up', value: numberInput(row, 'catchUp', 'w-28') },
                { label: 'Catch-Up Age', value: numberInput(row, 'catchUpAge', 'w-20') },
              ]}
            >
              <div className="mt-2">{rowActions(row)}</div>
            </MobileCard>
          ))}
        </div>
      ) : (
        <div className="border border-border rounded-md bg-surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-foreground-muted border-b border-border">
                <th className="px-4 py-2.5">Account Type</th>
                <th className="px-4 py-2.5 text-right">Base Limit</th>
                <th className="px-4 py-2.5 text-right">Catch-Up</th>
                <th className="px-4 py-2.5 text-right">Catch-Up Age</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.account_type} className="border-b border-border last:border-b-0 hover:bg-surface-hover/40">
                  <td className="px-4 py-2 text-foreground font-medium">{typeLabel(row.account_type)}</td>
                  <td className="px-4 py-2 text-right">{numberInput(row, 'base', 'w-28')}</td>
                  <td className="px-4 py-2 text-right">{numberInput(row, 'catchUp', 'w-24')}</td>
                  <td className="px-4 py-2 text-right">{numberInput(row, 'catchUpAge', 'w-20')}</td>
                  <td className="px-4 py-2">{sourceBadge(row.source, isDirty(row))}</td>
                  <td className="px-4 py-2">{rowActions(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-foreground-muted">
        Built-in defaults cover {EARLIEST_YEAR}–present as published by the IRS (Revenue Procedures and
        Notices). Brokerage and 529 accounts have no federal contribution limit and are not listed.
      </p>
    </div>
  );
}
