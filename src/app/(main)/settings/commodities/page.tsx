'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useToast } from '@/contexts/ToastContext';
import { CommodityEditorModal, type CommodityFormValues } from '@/components/commodities/CommodityEditorModal';
import { NamespaceSelector } from '@/components/commodities/NamespaceSelector';
import { EditableCell } from '@/components/commodities/EditableCell';
import { verifySymbol, verifySymbolsBulk } from '@/lib/hooks/useYahooSymbolVerify';

const COL_ORDER = ['namespace', 'mnemonic', 'fullname', 'cusip', 'fraction', 'quoteFlag', 'quoteSource', 'quoteTz'] as const;
type ColKey = typeof COL_ORDER[number];

interface CommodityRow {
  guid: string;
  namespace: string;
  mnemonic: string;
  fullname: string | null;
  cusip: string | null;
  fraction: number | string;
  quote_flag: boolean | number;
  quote_source: string | null;
  quote_tz: string | null;
}

interface EditableCommodityRow {
  guid: string;
  namespace: string;
  mnemonic: string;
  fullname: string;
  cusip: string;
  fraction: string;
  quoteFlag: boolean;
  quoteSource: string;
  quoteTz: string;
  // The committed values from the server, kept so we can compute dirty + discard.
  original: {
    namespace: string;
    mnemonic: string;
    fullname: string;
    cusip: string;
    fraction: string;
    quoteFlag: boolean;
    quoteSource: string;
    quoteTz: string;
  };
  verifyStatus: 'idle' | 'pending' | 'verified' | 'not_found';
  saving: boolean;
}

function rowsEqual(a: EditableCommodityRow): boolean {
  const o = a.original;
  return (
    a.namespace === o.namespace &&
    a.mnemonic === o.mnemonic &&
    a.fullname === o.fullname &&
    a.cusip === o.cusip &&
    a.fraction === o.fraction &&
    a.quoteFlag === o.quoteFlag &&
    a.quoteSource === o.quoteSource &&
    a.quoteTz === o.quoteTz
  );
}

function normalizeCommodity(row: CommodityRow): EditableCommodityRow {
  const snapshot = {
    namespace: row.namespace,
    mnemonic: row.mnemonic,
    fullname: row.fullname || '',
    cusip: row.cusip || '',
    fraction: String(row.fraction),
    quoteFlag: row.quote_flag === true || row.quote_flag === 1,
    quoteSource: row.quote_source || '',
    quoteTz: row.quote_tz || '',
  };
  return {
    guid: row.guid,
    ...snapshot,
    original: snapshot,
    verifyStatus: 'idle',
    saving: false,
  };
}

export default function CommodityPriceSettingsPage() {
  const { success, error: showError } = useToast();
  const [commodities, setCommodities] = useState<EditableCommodityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [hideCurrencyAccounts, setHideCurrencyAccounts] = useState(true);
  const [savingAll, setSavingAll] = useState(false);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [modalInitial, setModalInitial] = useState<CommodityFormValues | undefined>(undefined);

  const loadCommodities = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/commodities');
      if (!res.ok) throw new Error('Failed to load commodities');
      const data: CommodityRow[] = await res.json();
      setCommodities(data.map(normalizeCommodity));
    } catch {
      showError('Failed to load commodities');
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    loadCommodities();
  }, [loadCommodities]);

  const updateRow = useCallback(
    (guid: string, updater: (row: EditableCommodityRow) => EditableCommodityRow) => {
      setCommodities((current) => current.map((row) => (row.guid === guid ? updater(row) : row)));
    },
    []
  );

  const handleOpenCreate = useCallback(() => {
    setModalMode('create');
    setModalInitial(undefined);
    setModalOpen(true);
  }, []);

  const handleOpenEdit = useCallback((row: EditableCommodityRow) => {
    setModalMode('edit');
    setModalInitial({
      guid: row.guid,
      namespace: row.namespace,
      mnemonic: row.mnemonic,
      fullname: row.fullname,
      cusip: row.cusip,
      fraction: parseInt(row.fraction, 10) || 1,
      quoteFlag: row.quoteFlag,
      quoteSource: row.quoteSource,
      quoteTz: row.quoteTz,
    });
    setModalOpen(true);
  }, []);

  // Alt+N to open create modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'n' || e.key === 'N') && !modalOpen) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        e.preventDefault();
        handleOpenCreate();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleOpenCreate, modalOpen]);

  const verifyMnemonicForRow = useCallback(
    async (guid: string, sym: string, namespace: string) => {
      const trimmed = sym.trim();
      if (!trimmed || namespace.toUpperCase() === 'CURRENCY') {
        updateRow(guid, (r) => ({ ...r, verifyStatus: 'idle' }));
        return;
      }
      updateRow(guid, (r) => ({ ...r, verifyStatus: 'pending' }));
      const result = await verifySymbol(trimmed, namespace);
      updateRow(guid, (r) => {
        if (r.mnemonic.trim() !== trimmed) return r;
        const next: EditableCommodityRow = {
          ...r,
          verifyStatus: result.exists ? 'verified' : 'not_found',
        };
        // Auto-fill blank fullname from Yahoo on successful verify
        if (result.exists && result.fullname && !r.fullname.trim()) {
          next.fullname = result.fullname;
        }
        return next;
      });
    },
    [updateRow]
  );

  // Stable signature of (guid, mnemonic, namespace) tuples — used to trigger
  // bulk-verify only when the set of symbols changes, not on every edit.
  const symbolSignature = useMemo(
    () => commodities.map((c) => `${c.guid}:${c.mnemonic}:${c.namespace}`).join('|'),
    [commodities]
  );

  // On initial load (and after a reload), bulk-verify all non-CURRENCY symbols
  // so the table shows verification indicators for every row, and auto-fills
  // any rows missing a full name from Yahoo's response.
  useEffect(() => {
    if (loading || commodities.length === 0) return;
    const targets = commodities
      .filter((c) => c.namespace.toUpperCase() !== 'CURRENCY' && c.mnemonic.trim() && c.verifyStatus === 'idle')
      .map((c) => ({ guid: c.guid, symbol: c.mnemonic.trim(), namespace: c.namespace }));
    if (targets.length === 0) return;
    let cancelled = false;
    // Mark all as pending up-front so the UI feedback is immediate
    setCommodities((cur) =>
      cur.map((r) =>
        targets.some((t) => t.guid === r.guid) ? { ...r, verifyStatus: 'pending' } : r
      )
    );
    void verifySymbolsBulk(targets.map((t) => ({ symbol: t.symbol, namespace: t.namespace }))).then(
      (resultMap) => {
        if (cancelled) return;
        setCommodities((cur) =>
          cur.map((r) => {
            const t = targets.find((x) => x.guid === r.guid);
            if (!t) return r;
            const lookup = resultMap.get(t.symbol.toUpperCase());
            if (!lookup) return { ...r, verifyStatus: 'not_found' };
            const next: EditableCommodityRow = {
              ...r,
              verifyStatus: lookup.exists ? 'verified' : 'not_found',
            };
            // Apply fullname from Yahoo to original snapshot too — this is a
            // "synthetic" load-time enrichment, not a user edit, so it should
            // not show as dirty until the user actually changes something.
            if (lookup.exists && lookup.fullname && !r.fullname.trim()) {
              next.fullname = lookup.fullname;
              next.original = { ...r.original, fullname: lookup.fullname };
            }
            return next;
          })
        );
      }
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, symbolSignature]);

  const dirtyRows = useMemo(() => commodities.filter((r) => !rowsEqual(r)), [commodities]);

  const handleDiscardAll = useCallback(() => {
    setCommodities((current) =>
      current.map((row) => ({ ...row, ...row.original, verifyStatus: 'idle' }))
    );
  }, []);

  const handleSaveAll = useCallback(async () => {
    if (dirtyRows.length === 0 || savingAll) return;

    // Pre-flight: verify any dirty mnemonics whose namespace !== CURRENCY
    const toVerify = dirtyRows.filter(
      (r) => r.mnemonic.trim() !== r.original.mnemonic.trim() && r.namespace.toUpperCase() !== 'CURRENCY'
    );
    const verifyResults = await Promise.all(
      toVerify.map((r) => verifySymbol(r.mnemonic, r.namespace).then((res) => ({ row: r, res })))
    );
    const unverified = verifyResults.filter((v) => !v.res.exists).map((v) => v.row.mnemonic.trim());
    if (unverified.length > 0) {
      const ok = window.confirm(
        `The following symbols were not found on Yahoo Finance:\n\n${unverified.join(', ')}\n\nSave all changes anyway?`
      );
      if (!ok) return;
    }

    setSavingAll(true);
    const failures: string[] = [];

    await Promise.all(
      dirtyRows.map(async (row) => {
        const fraction = parseInt(row.fraction, 10);
        if (!Number.isFinite(fraction) || fraction < 1) {
          failures.push(`${row.mnemonic}: fraction must be a positive integer`);
          return;
        }
        updateRow(row.guid, (r) => ({ ...r, saving: true }));
        try {
          const res = await fetch('/api/commodities', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              guid: row.guid,
              namespace: row.namespace.trim(),
              mnemonic: row.mnemonic.trim(),
              fullname: row.fullname.trim() || null,
              cusip: row.cusip.trim() || null,
              fraction,
              quote_flag: row.quoteFlag,
              quote_source: row.quoteSource.trim() || null,
              quote_tz: row.quoteTz.trim() || null,
            }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            failures.push(`${row.mnemonic}: ${data.error || res.statusText}`);
            updateRow(row.guid, (r) => ({ ...r, saving: false }));
            return;
          }
          const updated = normalizeCommodity((await res.json()) as CommodityRow);
          updateRow(row.guid, () => updated);
        } catch (e) {
          failures.push(`${row.mnemonic}: ${e instanceof Error ? e.message : 'request failed'}`);
          updateRow(row.guid, (r) => ({ ...r, saving: false }));
        }
      })
    );

    setSavingAll(false);
    const saved = dirtyRows.length - failures.length;
    if (saved > 0) success(`Saved ${saved} commodit${saved === 1 ? 'y' : 'ies'}`);
    if (failures.length > 0) showError(`Failed: ${failures.join('; ')}`);
  }, [dirtyRows, savingAll, showError, success, updateRow]);

  // Stable arrow-key navigation: read the latest visible rows via a ref so the
  // handler reference doesn't change on every edit (which would invalidate the
  // columns memo and re-mount inputs mid-keystroke).
  const visibleRef = useRef<EditableCommodityRow[]>([]);

  const handleArrowNav = useCallback(
    (rowGuid: string, col: ColKey, dir: 'up' | 'down' | 'left' | 'right' | 'next' | 'prev') => {
      const rows = visibleRef.current;
      const colIdx = COL_ORDER.indexOf(col);
      const rowIdx = rows.findIndex((r) => r.guid === rowGuid);
      if (colIdx < 0 || rowIdx < 0) return;
      let nextRow = rowIdx;
      let nextCol = colIdx;
      if (dir === 'up') {
        nextRow = Math.max(0, rowIdx - 1);
      } else if (dir === 'down') {
        nextRow = Math.min(rows.length - 1, rowIdx + 1);
      } else if (dir === 'left') {
        nextCol = Math.max(0, colIdx - 1);
      } else if (dir === 'right') {
        nextCol = Math.min(COL_ORDER.length - 1, colIdx + 1);
      } else if (dir === 'next') {
        // Tab: advance one column; wrap to first col of next row at the end
        if (colIdx < COL_ORDER.length - 1) {
          nextCol = colIdx + 1;
        } else if (rowIdx < rows.length - 1) {
          nextRow = rowIdx + 1;
          nextCol = 0;
        }
      } else if (dir === 'prev') {
        // Shift+Tab: retreat one column; wrap to last col of prev row at the start
        if (colIdx > 0) {
          nextCol = colIdx - 1;
        } else if (rowIdx > 0) {
          nextRow = rowIdx - 1;
          nextCol = COL_ORDER.length - 1;
        }
      }
      const targetRow = rows[nextRow];
      if (!targetRow) return;
      const sel = `[data-cell="${targetRow.guid}:${COL_ORDER[nextCol]}"]`;
      const el = document.querySelector(sel) as HTMLElement | null;
      el?.focus();
    },
    []
  );

  // Stable namespace key — only changes when the *set* of namespaces changes,
  // not on every fullname/cusip/etc. keystroke. Without this, the columns memo
  // (which depends on namespaceSuggestions) recomputes on every edit and the
  // table cells get re-mounted, losing input focus mid-keystroke.
  const namespaceKey = useMemo(
    () => Array.from(new Set(commodities.map((c) => c.namespace))).sort().join('|'),
    [commodities]
  );
  const namespaceSuggestions = useMemo(() => {
    const set = new Set<string>(['CURRENCY', 'NASDAQ', 'NYSE', 'AMEX', 'FUND', 'ETF', 'BOND']);
    if (namespaceKey) for (const ns of namespaceKey.split('|')) set.add(ns);
    return Array.from(set).sort();
  }, [namespaceKey]);

  const renderVerifyBadge = useCallback((status: EditableCommodityRow['verifyStatus']) => {
    if (status === 'idle') return null;
    if (status === 'pending') {
      return (
        <span
          className="inline-block w-3 h-3 border-2 border-foreground-muted/40 border-t-foreground-muted rounded-full animate-spin"
          title="Checking Yahoo Finance..."
        />
      );
    }
    if (status === 'verified') {
      return (
        <span className="text-success text-xs" title="Verified on Yahoo Finance" aria-label="verified">
          ✅
        </span>
      );
    }
    return (
      <span className="text-warning text-xs" title="Not found on Yahoo Finance" aria-label="not found">
        ⚠️
      </span>
    );
  }, []);

  const columns = useMemo<ColumnDef<EditableCommodityRow>[]>(
    () => [
      {
        accessorKey: 'namespace',
        header: 'Namespace',
        cell: ({ row }) => (
          <NamespaceSelector
            value={row.original.namespace}
            options={namespaceSuggestions}
            onChange={(v) =>
              updateRow(row.original.guid, (r) => ({ ...r, namespace: v, verifyStatus: 'idle' }))
            }
            borderless
            compact
            className="w-32"
            cellId={`${row.original.guid}:namespace`}
            onArrowNav={(dir) => handleArrowNav(row.original.guid, 'namespace', dir)}
          />
        ),
      },
      {
        accessorKey: 'mnemonic',
        header: 'Symbol',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <EditableCell
              value={row.original.mnemonic}
              onChange={(v) => {
                const next = v.toUpperCase();
                updateRow(row.original.guid, (r) => ({ ...r, mnemonic: next, verifyStatus: 'idle' }));
                void verifyMnemonicForRow(row.original.guid, next, row.original.namespace);
              }}
              width="w-28"
              mono
              upper
              cellId={`${row.original.guid}:mnemonic`}
              onArrowNav={(dir) => handleArrowNav(row.original.guid, 'mnemonic', dir)}
            />
            {renderVerifyBadge(row.original.verifyStatus)}
          </div>
        ),
      },
      {
        accessorKey: 'fullname',
        header: 'Full Name',
        cell: ({ row }) => (
          <EditableCell
            value={row.original.fullname}
            onChange={(v) => updateRow(row.original.guid, (r) => ({ ...r, fullname: v }))}
            width="w-56"
            cellId={`${row.original.guid}:fullname`}
            onArrowNav={(dir) => handleArrowNav(row.original.guid, 'fullname', dir)}
          />
        ),
      },
      {
        accessorKey: 'cusip',
        header: 'CUSIP',
        cell: ({ row }) => (
          <EditableCell
            value={row.original.cusip}
            onChange={(v) => updateRow(row.original.guid, (r) => ({ ...r, cusip: v }))}
            width="w-32"
            mono
            cellId={`${row.original.guid}:cusip`}
            onArrowNav={(dir) => handleArrowNav(row.original.guid, 'cusip', dir)}
          />
        ),
      },
      {
        accessorKey: 'fraction',
        header: 'Fraction',
        cell: ({ row }) => (
          <EditableCell
            value={row.original.fraction}
            onChange={(v) => updateRow(row.original.guid, (r) => ({ ...r, fraction: v }))}
            type="number"
            width="w-24"
            mono
            align="right"
            cellId={`${row.original.guid}:fraction`}
            onArrowNav={(dir) => handleArrowNav(row.original.guid, 'fraction', dir)}
          />
        ),
      },
      {
        id: 'quoteFlag',
        header: 'Quote',
        cell: ({ row }) => {
          const cellId = `${row.original.guid}:quoteFlag`;
          return (
            <span
              tabIndex={0}
              data-cell={cellId}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  updateRow(row.original.guid, (r) => ({ ...r, quoteFlag: !r.quoteFlag }));
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  const dir = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowLeft' ? 'left' : 'right';
                  handleArrowNav(row.original.guid, 'quoteFlag', dir);
                }
              }}
              className="inline-flex items-center justify-center w-8 h-7 rounded focus:outline-none focus:bg-primary/10 focus:ring-1 focus:ring-primary/40 hover:bg-surface-hover/40 cursor-pointer"
              onClick={() => updateRow(row.original.guid, (r) => ({ ...r, quoteFlag: !r.quoteFlag }))}
            >
              <input
                type="checkbox"
                checked={row.original.quoteFlag}
                readOnly
                tabIndex={-1}
                className="w-4 h-4 rounded border-border bg-background-tertiary pointer-events-none"
              />
            </span>
          );
        },
      },
      {
        id: 'quoteSource',
        header: 'Quote Source',
        cell: ({ row }) => (
          <EditableCell
            value={row.original.quoteSource}
            onChange={(v) => updateRow(row.original.guid, (r) => ({ ...r, quoteSource: v }))}
            placeholder="Finance::Quote"
            width="w-40"
            cellId={`${row.original.guid}:quoteSource`}
            onArrowNav={(dir) => handleArrowNav(row.original.guid, 'quoteSource', dir)}
          />
        ),
      },
      {
        id: 'quoteTz',
        header: 'Quote TZ',
        cell: ({ row }) => (
          <EditableCell
            value={row.original.quoteTz}
            onChange={(v) => updateRow(row.original.guid, (r) => ({ ...r, quoteTz: v }))}
            placeholder="America/New_York"
            width="w-40"
            cellId={`${row.original.guid}:quoteTz`}
            onArrowNav={(dir) => handleArrowNav(row.original.guid, 'quoteTz', dir)}
          />
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const dirty = !rowsEqual(row.original);
          return (
            <div className="flex items-center gap-2">
              {dirty && (
                <span className="text-xs text-warning" title="Unsaved changes">
                  ●
                </span>
              )}
              <button
                onClick={() => handleOpenEdit(row.original)}
                className="p-1.5 text-foreground-secondary hover:text-foreground hover:bg-surface-hover rounded transition-colors"
                title="Edit in modal"
                aria-label="Edit commodity in modal"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
            </div>
          );
        },
      },
    ],
    [handleArrowNav, handleOpenEdit, namespaceSuggestions, renderVerifyBadge, updateRow, verifyMnemonicForRow]
  );

  const visibleCommodities = useMemo(
    () => commodities.filter((row) => !hideCurrencyAccounts || row.namespace !== 'CURRENCY'),
    [commodities, hideCurrencyAccounts]
  );

  useEffect(() => {
    visibleRef.current = visibleCommodities;
  }, [visibleCommodities]);

  const table = useReactTable({
    data: visibleCommodities,
    columns,
    state: { globalFilter: search },
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const searchValue = String(filterValue).toLowerCase();
      return [
        row.original.namespace,
        row.original.mnemonic,
        row.original.fullname,
        row.original.cusip,
        row.original.quoteSource,
        row.original.quoteTz,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(searchValue));
    },
  });

  const quoteEnabledCount = useMemo(
    () => visibleCommodities.filter((row) => row.quoteFlag).length,
    [visibleCommodities]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Commodity Quote Settings</h1>
          <p className="text-foreground-muted mt-1">
            Add, edit, and manage commodities, fractions, and price source metadata.
          </p>
        </div>
        <Link
          href="/settings"
          className="px-4 py-2 text-sm bg-background-tertiary text-foreground-secondary hover:bg-surface-hover rounded-lg transition-colors"
        >
          Back to Settings
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl border border-border p-4">
          <div className="text-xs uppercase tracking-wider text-foreground-muted">Total Commodities</div>
          <div className="text-2xl font-semibold text-foreground mt-2">{visibleCommodities.length}</div>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <div className="text-xs uppercase tracking-wider text-foreground-muted">Quote Enabled</div>
          <div className="text-2xl font-semibold text-foreground mt-2">{quoteEnabledCount}</div>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <div className="text-xs uppercase tracking-wider text-foreground-muted">Unsaved Changes</div>
          <div className="text-2xl font-semibold text-foreground mt-2">{dirtyRows.length}</div>
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">All Commodities</h2>
            <p className="text-sm text-foreground-muted mt-1">
              Edit any cell, then save all changes at once. <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded text-foreground-secondary text-xs">Alt+N</kbd> to add a new commodity.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={hideCurrencyAccounts}
                onChange={(event) => setHideCurrencyAccounts(event.target.checked)}
                className="w-4 h-4 rounded border-border bg-background-tertiary"
              />
              Hide currency accounts
            </label>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search symbol, name, source, timezone..."
              className="w-full md:w-80 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
            />
          </div>
        </div>

        <div className="p-4 border-b border-border flex flex-wrap items-center gap-2">
          <button
            onClick={handleOpenCreate}
            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors inline-flex items-center gap-2"
            title="Add commodity (Alt+N)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Commodity
          </button>
          <button
            onClick={handleSaveAll}
            disabled={dirtyRows.length === 0 || savingAll}
            className="px-4 py-2 text-sm bg-success hover:bg-success/80 disabled:bg-success/30 text-white rounded-lg transition-colors disabled:cursor-not-allowed"
          >
            {savingAll ? 'Saving…' : dirtyRows.length > 0 ? `Save All (${dirtyRows.length})` : 'Save All'}
          </button>
          <button
            onClick={handleDiscardAll}
            disabled={dirtyRows.length === 0 || savingAll}
            className="px-4 py-2 text-sm bg-background-tertiary text-foreground-secondary hover:bg-surface-hover disabled:text-foreground-muted disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            Discard All
          </button>
          <div className="flex-1" />
          <button
            onClick={loadCommodities}
            className="px-4 py-2 text-sm bg-background-tertiary text-foreground-secondary hover:bg-surface-hover rounded-lg transition-colors"
          >
            Reload
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-foreground-secondary">Loading commodities...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px]">
              <thead className="bg-background-tertiary/50">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th
                        key={header.id}
                        className="px-3 py-3 text-left text-sm font-medium text-foreground-secondary whitespace-nowrap"
                      >
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-border">
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="align-middle">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </div>

      <CommodityEditorModal
        isOpen={modalOpen}
        mode={modalMode}
        initial={modalInitial}
        namespaceSuggestions={namespaceSuggestions}
        onClose={() => setModalOpen(false)}
        onSaved={loadCommodities}
      />
    </div>
  );
}
