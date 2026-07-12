'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { txfCodesByForm, TXF_CODES } from '@/lib/tax/txf-codes';

/* ------------------------------------------------------------------ */
/* API payload types (mirror src/lib/tax/tax-schedule.ts)               */
/* ------------------------------------------------------------------ */

interface AccountRow {
  accountGuid: string;
  path: string;
  accountType: string;
  amount: number;
  source: 'override' | 'category';
  category: string | null;
}

interface LineItem {
  code: string;
  form: string;
  line: string;
  description: string;
  sign: 'income' | 'deduction';
  payerSupported: boolean;
  accounts: AccountRow[];
  total: number;
}

interface UnmappedAccount {
  accountGuid: string;
  path: string;
  accountType: string;
  amount: number;
}

interface TaxScheduleReport {
  year: number;
  generatedAt: string;
  items: LineItem[];
  unmappedTaxRelated: UnmappedAccount[];
  overrides: Record<string, string>;
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 10 }, (_, i) => CURRENT_YEAR - i);
const CODE_GROUPS = txfCodesByForm();
const CODE_LABELS = new Map(TXF_CODES.map(c => [c.code, `${c.code} — ${c.description}`]));

function TxfCodeSelect({
  value,
  onChange,
  dirty,
}: {
  value: string;
  onChange: (v: string) => void;
  dirty: boolean;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={`bg-background-tertiary border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-primary max-w-[300px] ${dirty ? 'border-primary' : 'border-border'}`}
    >
      <option value="">— No override —</option>
      {CODE_GROUPS.map(group => (
        <optgroup key={group.form} label={group.form}>
          {group.codes.map(c => (
            <option key={c.code} value={c.code}>
              {c.code} · {c.description}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function TaxSchedulePage() {
  const [year, setYear] = useState(CURRENT_YEAR - 1);
  const [data, setData] = useState<TaxScheduleReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showMapper, setShowMapper] = useState(false);
  const [mapperSearch, setMapperSearch] = useState('');
  /** Pending override edits: guid → code ('' = remove override). */
  const [pending, setPending] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/tax-schedule?year=${year}`);
      if (!res.ok) throw new Error('Failed to fetch report');
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleExpanded = (code: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const downloadTxf = useCallback(async () => {
    try {
      const res = await fetch(`/api/reports/tax-schedule?year=${year}&format=txf`);
      if (!res.ok) throw new Error('Download failed');
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/plain;charset=us-ascii' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `tax-${year}.txf`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch {
      setError('TXF download failed');
    }
  }, [year]);

  /* ---------------- Grouping by form ---------------- */

  const formGroups = useMemo(() => {
    if (!data) return [];
    const groups: Array<{ form: string; items: LineItem[] }> = [];
    for (const item of data.items) {
      const last = groups[groups.length - 1];
      if (last && last.form === item.form) last.items.push(item);
      else groups.push({ form: item.form, items: [item] });
    }
    return groups;
  }, [data]);

  /* ---------------- Mapping panel ---------------- */

  /** Candidate accounts for overrides: everything on the report + unmapped. */
  const mapperAccounts = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, { guid: string; path: string; accountType: string; current: string }>();
    for (const item of data.items) {
      for (const a of item.accounts) {
        seen.set(a.accountGuid, {
          guid: a.accountGuid,
          path: a.path,
          accountType: a.accountType,
          current: data.overrides[a.accountGuid] ?? '',
        });
      }
    }
    for (const a of data.unmappedTaxRelated) {
      if (!seen.has(a.accountGuid)) {
        seen.set(a.accountGuid, {
          guid: a.accountGuid,
          path: a.path,
          accountType: a.accountType,
          current: data.overrides[a.accountGuid] ?? '',
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [data]);

  const visibleMapperAccounts = useMemo(() => {
    const term = mapperSearch.trim().toLowerCase();
    if (!term) return mapperAccounts;
    return mapperAccounts.filter(a => a.path.toLowerCase().includes(term));
  }, [mapperAccounts, mapperSearch]);

  const setOverride = (guid: string, code: string) => {
    setPending(prev => {
      const next = { ...prev };
      const original = data?.overrides[guid] ?? '';
      if (code === original) delete next[guid];
      else next[guid] = code;
      return next;
    });
  };

  const pendingCount = Object.keys(pending).length;

  const saveOverrides = async () => {
    if (pendingCount === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/reports/tax-schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overrides: Object.entries(pending).map(([accountGuid, code]) => ({
            accountGuid,
            code: code === '' ? null : code,
          })),
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? 'Failed to save overrides');
      }
      setPending({});
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save overrides');
    } finally {
      setSaving(false);
    }
  };

  const hasContent = (data?.items.length ?? 0) > 0;

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tax Schedule Report</h1>
          <p className="text-sm text-foreground-muted mt-1">
            Tax-related activity grouped by TXF code and IRS form, exportable as a .txf file
            for TurboTax / TaxCut import.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-xs text-foreground-muted uppercase tracking-wider">Tax Year</span>
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="px-3 py-1.5 text-sm bg-surface border border-border rounded-md text-foreground font-mono tabular-nums"
            >
              {YEAR_OPTIONS.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          <button
            onClick={downloadTxf}
            disabled={!hasContent}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Download .txf
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <span className="text-foreground-secondary">Loading...</span>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-negative/10 border border-negative/20 rounded-lg p-4 text-negative text-sm">
          {error}
        </div>
      )}

      {data && !loading && (
        <>
          {/* Unmapped tax-related accounts warning */}
          {data.unmappedTaxRelated.length > 0 && (
            <div className="bg-warning/5 border border-warning/30 rounded-lg p-4">
              <div className="flex items-center gap-2 text-warning font-semibold text-sm mb-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                {data.unmappedTaxRelated.length} tax-related {data.unmappedTaxRelated.length === 1 ? 'account has' : 'accounts have'} no TXF code
              </div>
              <p className="text-xs text-foreground-secondary mb-3">
                These accounts are flagged &ldquo;tax related&rdquo; but resolve to no TXF line, so they are
                missing from the report and export. Assign a code in the mapping panel below (or map them to a
                tax category in the Tax Estimator).
              </p>
              <ul className="space-y-1">
                {data.unmappedTaxRelated.map(a => (
                  <li key={a.accountGuid} className="flex items-center justify-between gap-4 text-xs">
                    <span className="text-foreground-secondary truncate" title={a.path}>{a.path}</span>
                    <span className="font-mono tabular-nums text-foreground-muted shrink-0">
                      {formatCurrency(a.amount, 'USD')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Grouped report */}
          {!hasContent ? (
            <div className="bg-surface border border-border rounded-lg p-8 text-center text-foreground-muted text-sm">
              No TXF-mapped tax activity found for {year}. Map accounts to tax categories in the
              Tax Estimator, flag accounts as tax related, or add per-account TXF overrides below.
            </div>
          ) : (
            formGroups.map(group => (
              <div key={group.form} className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="p-4 border-b border-border flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                    {group.form === '1040' ? 'Form 1040' : group.form}
                  </h3>
                  <span className="text-[11px] text-foreground-muted">
                    {group.items.length} line {group.items.length === 1 ? 'item' : 'items'}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                        <th className="px-4 py-2.5 text-left w-8"></th>
                        <th className="px-4 py-2.5 text-left w-20">Code</th>
                        <th className="px-4 py-2.5 text-left w-28">Line</th>
                        <th className="px-4 py-2.5 text-left">Description</th>
                        <th className="px-4 py-2.5 text-right w-28">Accounts</th>
                        <th className="px-4 py-2.5 text-right w-36">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map(item => {
                        const isOpen = expanded.has(item.code);
                        return (
                          <FragmentRows
                            key={item.code}
                            item={item}
                            isOpen={isOpen}
                            onToggle={() => toggleExpanded(item.code)}
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}

          {/* Mapping panel */}
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setShowMapper(v => !v)}
              className="w-full p-4 flex items-center justify-between text-left hover:bg-surface-hover transition-colors"
            >
              <div>
                <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                  TXF Code Overrides
                </h3>
                <p className="text-xs text-foreground-muted mt-0.5">
                  Pin an account to a specific TXF code — overrides win over its tax-category default.
                </p>
              </div>
              <span className="text-xs text-foreground-muted">{showMapper ? 'Hide' : 'Show'}</span>
            </button>

            {showMapper && (
              <div className="border-t border-border p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={mapperSearch}
                    onChange={e => setMapperSearch(e.target.value)}
                    placeholder="Search accounts..."
                    className="flex-1 min-w-[200px] bg-background-tertiary border border-border rounded-md px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:border-primary"
                  />
                  <button
                    onClick={saveOverrides}
                    disabled={pendingCount === 0 || saving}
                    className="text-xs font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary-hover transition-colors"
                  >
                    {saving
                      ? 'Saving…'
                      : pendingCount > 0
                        ? `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`
                        : 'Saved'}
                  </button>
                </div>

                <div className="border border-border rounded-md overflow-hidden max-h-[420px] overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background-tertiary">
                      <tr className="text-left text-xs text-foreground-muted">
                        <th className="px-3 py-2 font-medium">Account</th>
                        <th className="px-3 py-2 font-medium w-24">Type</th>
                        <th className="px-3 py-2 font-medium w-[320px]">TXF Code Override</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleMapperAccounts.map(a => {
                        const dirty = a.guid in pending;
                        const value = dirty ? pending[a.guid] : a.current;
                        return (
                          <tr key={a.guid} className="border-t border-border hover:bg-surface-hover">
                            <td className="px-3 py-1.5">
                              <div className="text-foreground text-xs truncate max-w-md" title={a.path}>
                                {a.path}
                              </div>
                              {value && (
                                <div className="text-[11px] text-foreground-muted">
                                  {CODE_LABELS.get(value)}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-[11px] text-foreground-muted font-mono">
                              {a.accountType}
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="inline-flex items-center gap-1.5">
                                <TxfCodeSelect
                                  value={value}
                                  onChange={v => setOverride(a.guid, v)}
                                  dirty={dirty}
                                />
                                {dirty && (
                                  <span className="text-[10px] uppercase text-warning">edited</span>
                                )}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {visibleMapperAccounts.length === 0 && (
                        <tr>
                          <td colSpan={3} className="px-3 py-6 text-center text-sm text-foreground-muted">
                            No accounts to map. Accounts appear here once they carry a tax-category
                            mapping, a TXF override, or the tax-related flag.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-foreground-muted">
                  TXF reference codes follow the GnuCash desktop / Tax Exchange Format V042 tables.
                  Verify imported values against source documents before filing.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One TXF line item row + its expandable per-account drill-down rows. */
function FragmentRows({
  item,
  isOpen,
  onToggle,
}: {
  item: LineItem;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-b border-border/40 cursor-pointer hover:bg-surface-hover transition-colors"
      >
        <td className="px-4 py-2.5 text-foreground-muted text-xs select-none">
          <span className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
        </td>
        <td className="px-4 py-2.5 font-mono text-xs text-secondary">{item.code}</td>
        <td className="px-4 py-2.5 font-mono text-xs text-foreground-muted">{item.line}</td>
        <td className="px-4 py-2.5 text-foreground">
          {item.description}
          {item.payerSupported && (
            <span className="ml-2 text-[9px] uppercase tracking-wider text-foreground-muted border border-border rounded px-1 py-px align-middle">
              per payer
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-xs text-foreground-muted">
          {item.accounts.length}
        </td>
        <td
          className={`px-4 py-2.5 text-right font-mono tabular-nums font-medium ${
            item.total < 0 ? 'text-negative' : item.sign === 'income' ? 'text-positive' : 'text-foreground'
          }`}
        >
          {formatCurrency(item.total, 'USD')}
        </td>
      </tr>
      {isOpen &&
        item.accounts.map(a => (
          <tr key={a.accountGuid} className="border-b border-border/40 bg-background-tertiary/40">
            <td className="px-4 py-1.5"></td>
            <td className="px-4 py-1.5"></td>
            <td className="px-4 py-1.5"></td>
            <td className="px-4 py-1.5 text-xs text-foreground-secondary" title={a.path}>
              {a.path}
              {a.source === 'override' && (
                <span className="ml-2 text-[9px] uppercase tracking-wider text-primary border border-primary/40 rounded px-1 py-px align-middle">
                  override
                </span>
              )}
            </td>
            <td className="px-4 py-1.5"></td>
            <td className="px-4 py-1.5 text-right font-mono tabular-nums text-xs text-foreground-secondary">
              {formatCurrency(a.amount, 'USD')}
            </td>
          </tr>
        ))}
    </>
  );
}
