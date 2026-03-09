'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useToast } from '@/contexts/ToastContext';

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
  dirty: boolean;
  saving: boolean;
}

function normalizeCommodity(row: CommodityRow): EditableCommodityRow {
  return {
    guid: row.guid,
    namespace: row.namespace,
    mnemonic: row.mnemonic,
    fullname: row.fullname || '',
    cusip: row.cusip || '',
    fraction: String(row.fraction),
    quoteFlag: row.quote_flag === true || row.quote_flag === 1,
    quoteSource: row.quote_source || '',
    quoteTz: row.quote_tz || '',
    dirty: false,
    saving: false,
  };
}

export default function CommodityPriceSettingsPage() {
  const { success, error: showError } = useToast();
  const [commodities, setCommodities] = useState<EditableCommodityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [hideCurrencyAccounts, setHideCurrencyAccounts] = useState(true);

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

  const updateRow = useCallback((guid: string, updater: (row: EditableCommodityRow) => EditableCommodityRow) => {
    setCommodities((current) =>
      current.map((row) => (row.guid === guid ? updater(row) : row))
    );
  }, []);

  const handleSave = useCallback(async (guid: string) => {
    const row = commodities.find((entry) => entry.guid === guid);
    if (!row) return;

    updateRow(guid, (current) => ({ ...current, saving: true }));

    try {
      const res = await fetch('/api/commodities', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guid,
          quote_flag: row.quoteFlag,
          quote_source: row.quoteSource || null,
          quote_tz: row.quoteTz || null,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to save commodity');
      }

      const updated = normalizeCommodity(await res.json() as CommodityRow);
      updateRow(guid, () => ({ ...updated, dirty: false, saving: false }));
      success(`Saved quote settings for ${row.mnemonic}`);
    } catch {
      updateRow(guid, (current) => ({ ...current, saving: false }));
      showError(`Failed to save ${row.mnemonic}`);
    }
  }, [commodities, showError, success, updateRow]);

  const columns = useMemo<ColumnDef<EditableCommodityRow>[]>(() => [
    {
      accessorKey: 'namespace',
      header: 'Namespace',
      cell: ({ row }) => <span className="text-foreground-secondary">{row.original.namespace}</span>,
    },
    {
      accessorKey: 'mnemonic',
      header: 'Symbol',
      cell: ({ row }) => <span className="font-medium text-foreground">{row.original.mnemonic}</span>,
    },
    {
      accessorKey: 'fullname',
      header: 'Full Name',
      cell: ({ row }) => (
        <div className="min-w-[14rem]">
          <div className="text-foreground">{row.original.fullname || '\u2014'}</div>
          {row.original.cusip && (
            <div className="text-xs text-foreground-muted mt-1">CUSIP: {row.original.cusip}</div>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'fraction',
      header: 'Fraction',
      cell: ({ row }) => <span className="font-mono text-foreground-secondary">{row.original.fraction}</span>,
    },
    {
      id: 'quoteFlag',
      header: 'Quote Flag',
      cell: ({ row }) => (
        <label className="inline-flex items-center gap-2 text-sm text-foreground-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={row.original.quoteFlag}
            onChange={(event) => {
              const checked = event.target.checked;
              updateRow(row.original.guid, (current) => ({
                ...current,
                quoteFlag: checked,
                dirty: true,
              }));
            }}
            className="w-4 h-4 rounded border-border bg-background-tertiary"
          />
          {row.original.quoteFlag ? 'Enabled' : 'Disabled'}
        </label>
      ),
    },
    {
      id: 'quoteSource',
      header: 'Quote Source',
      cell: ({ row }) => (
        <input
          value={row.original.quoteSource}
          onChange={(event) => {
            const value = event.target.value;
            updateRow(row.original.guid, (current) => ({
              ...current,
              quoteSource: value,
              dirty: true,
            }));
          }}
          placeholder="Finance::Quote"
          className="w-44 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
        />
      ),
    },
    {
      id: 'quoteTz',
      header: 'Quote TZ',
      cell: ({ row }) => (
        <input
          value={row.original.quoteTz}
          onChange={(event) => {
            const value = event.target.value;
            updateRow(row.original.guid, (current) => ({
              ...current,
              quoteTz: value,
              dirty: true,
            }));
          }}
          placeholder="America/New_York"
          className="w-44 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
        />
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <button
          onClick={() => handleSave(row.original.guid)}
          disabled={!row.original.dirty || row.original.saving}
          className="px-3 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/40 text-white rounded-lg transition-colors disabled:cursor-not-allowed"
        >
          {row.original.saving ? 'Saving...' : 'Save'}
        </button>
      ),
    },
  ], [handleSave, updateRow]);

  const visibleCommodities = useMemo(
    () => commodities.filter((row) => !hideCurrencyAccounts || row.namespace !== 'CURRENCY'),
    [commodities, hideCurrencyAccounts]
  );

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
  const dirtyCount = useMemo(
    () => commodities.filter((row) => row.dirty).length,
    [commodities]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Commodity Quote Settings</h1>
          <p className="text-foreground-muted mt-1">
            Manage quoteable commodities, price source metadata, and historical price tracking flags.
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
          <div className="text-2xl font-semibold text-foreground mt-2">{dirtyCount}</div>
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Quoteable Price History</h2>
            <p className="text-sm text-foreground-muted mt-1">
              Quote flag controls whether the commodity participates in historical Yahoo price refreshes.
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
              className="w-full md:w-80 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
            />
            <button
              onClick={loadCommodities}
              className="px-4 py-2 text-sm bg-background-tertiary text-foreground-secondary hover:bg-surface-hover rounded-lg transition-colors"
            >
              Reload
            </button>
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-foreground-secondary">Loading commodities...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead className="bg-background-tertiary/50">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id} className="px-4 py-3 text-left text-sm font-medium text-foreground-secondary">
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-border">
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="align-top">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3">
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
    </div>
  );
}
