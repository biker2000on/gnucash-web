'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type RowSelectionState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import PayslipUploadZone from '@/components/payslips/PayslipUploadZone';
import PayslipDetailPanel from '@/components/payslips/PayslipDetailPanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Payslip {
  id: number;
  employer_name: string;
  pay_date: string;
  gross_pay: number | null;
  net_pay: number | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  processing: 'bg-blue-500/10 text-blue-400',
  needs_mapping: 'bg-yellow-500/10 text-yellow-400',
  ready: 'bg-green-500/10 text-green-400',
  posted: 'bg-primary/10 text-primary',
  error: 'bg-red-500/10 text-red-400',
};

const STATUS_LABELS: Record<string, string> = {
  processing: 'Processing',
  needs_mapping: 'Needs Mapping',
  ready: 'Ready',
  posted: 'Posted',
  error: 'Error',
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? 'bg-surface text-foreground-muted';
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${style}`}>{label}</span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return '$' + Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Sort icon
// ---------------------------------------------------------------------------

function SortIcon({ direction }: { direction: 'asc' | 'desc' | false }) {
  if (!direction) {
    return (
      <svg className="w-3 h-3 ml-1 inline opacity-30" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" d="M7 8l5-5 5 5M7 16l5 5 5-5" />
      </svg>
    );
  }
  return (
    <svg className="w-3 h-3 ml-1 inline text-primary" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      {direction === 'asc'
        ? <path strokeLinecap="round" d="M7 14l5-5 5 5" />
        : <path strokeLinecap="round" d="M7 10l5 5 5-5" />
      }
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const columnHelper = createColumnHelper<Payslip>();

const columns = [
  columnHelper.display({
    id: 'select',
    header: ({ table }) => (
      <input
        type="checkbox"
        checked={table.getIsAllPageRowsSelected()}
        onChange={table.getToggleAllPageRowsSelectedHandler()}
        className="rounded border-border"
      />
    ),
    cell: ({ row }) => {
      if (row.original.status === 'posted') return null;
      return (
        <input
          type="checkbox"
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
          onClick={e => e.stopPropagation()}
          className="rounded border-border"
        />
      );
    },
    size: 40,
    enableSorting: false,
  }),
  columnHelper.accessor('pay_date', {
    header: 'Pay Date',
    cell: info => formatDate(info.getValue()),
    sortingFn: 'datetime',
  }),
  columnHelper.accessor('employer_name', {
    header: 'Employer',
    filterFn: 'includesString',
  }),
  columnHelper.accessor('gross_pay', {
    header: 'Gross',
    cell: info => formatAmount(info.getValue()),
    sortingFn: 'basic',
    meta: { align: 'right' },
  }),
  columnHelper.accessor('net_pay', {
    header: 'Net',
    cell: info => formatAmount(info.getValue()),
    sortingFn: 'basic',
    meta: { align: 'right' },
  }),
  columnHelper.accessor('status', {
    header: 'Status',
    cell: info => <StatusBadge status={info.getValue()} />,
    filterFn: 'equals',
  }),
];

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function PayslipsPage() {
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Table state
  const [sorting, setSorting] = useState<SortingState>([{ id: 'pay_date', desc: true }]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  const fetchPayslips = useCallback(async () => {
    try {
      const res = await fetch('/api/payslips');
      if (!res.ok) throw new Error('Failed to fetch payslips');
      const data: Payslip[] = await res.json();
      setPayslips(data);
    } catch (err) {
      console.error('Failed to load payslips:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPayslips(); }, [fetchPayslips]);

  const handleUploadComplete = useCallback(() => {
    fetchPayslips();
    setShowUpload(false);
  }, [fetchPayslips]);

  const table = useReactTable({
    data: payslips,
    columns,
    state: { sorting, rowSelection, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getRowId: row => String(row.id),
    enableRowSelection: row => row.original.status !== 'posted',
  });

  const selectedCount = Object.keys(rowSelection).length;

  const handleBulkDelete = useCallback(async () => {
    const ids = Object.keys(rowSelection).map(Number);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} payslip${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await Promise.all(ids.map(id => fetch(`/api/payslips/${id}`, { method: 'DELETE' })));
      setRowSelection({});
      fetchPayslips();
    } catch (err) {
      console.error('Bulk delete failed:', err);
    } finally {
      setDeleting(false);
    }
  }, [rowSelection, fetchPayslips]);

  // Status filter as a column filter
  const statusFilter = useMemo(() => {
    const f = columnFilters.find(f => f.id === 'status');
    return (f?.value as string) || 'all';
  }, [columnFilters]);

  const setStatusFilter = useCallback((value: string) => {
    if (value === 'all') {
      setColumnFilters(prev => prev.filter(f => f.id !== 'status'));
    } else {
      setColumnFilters(prev => [
        ...prev.filter(f => f.id !== 'status'),
        { id: 'status', value },
      ]);
    }
  }, []);

  const filteredCount = table.getFilteredRowModel().rows.length;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-foreground">Payslips</h1>
        <button
          onClick={() => setShowUpload(prev => !prev)}
          className="bg-primary text-background hover:bg-primary-hover rounded-lg px-4 py-2 text-sm font-medium transition-colors"
        >
          {showUpload ? 'Cancel' : 'Upload Payslip'}
        </button>
      </div>

      {/* Upload zone */}
      {showUpload && (
        <div className="bg-surface/30 backdrop-blur-xl rounded-2xl border border-border p-6">
          <PayslipUploadZone onUploadComplete={handleUploadComplete} />
        </div>
      )}

      {/* Filter row */}
      <div className="flex items-center gap-4">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:ring-2 focus:ring-primary/40 focus:outline-none"
        >
          <option value="all">All</option>
          <option value="processing">Processing</option>
          <option value="needs_mapping">Needs Mapping</option>
          <option value="ready">Ready</option>
          <option value="posted">Posted</option>
          <option value="error">Error</option>
        </select>

        <input
          type="text"
          value={globalFilter}
          onChange={e => setGlobalFilter(e.target.value)}
          placeholder="Search..."
          className="bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:ring-2 focus:ring-primary/40 focus:outline-none w-48"
        />

        {!loading && (
          <span className="text-sm text-foreground-muted">
            {filteredCount} {filteredCount === 1 ? 'payslip' : 'payslips'}
          </span>
        )}

        {selectedCount > 0 && (
          <button
            onClick={handleBulkDelete}
            disabled={deleting}
            className="ml-auto px-3 py-1.5 text-xs font-medium rounded-lg bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 disabled:opacity-40 transition-colors"
          >
            {deleting ? 'Deleting...' : `Delete ${selectedCount} selected`}
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-surface/30 backdrop-blur-xl rounded-2xl border border-border overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <span className="text-sm text-foreground-muted">Loading...</span>
          </div>
        ) : table.getFilteredRowModel().rows.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <span className="text-sm text-foreground-muted">
              {payslips.length === 0
                ? 'No payslips yet. Upload one to get started.'
                : 'No payslips match your filters.'}
            </span>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              {table.getHeaderGroups().map(headerGroup => (
                <tr key={headerGroup.id} className="text-left">
                  {headerGroup.headers.map(header => {
                    const align = (header.column.columnDef.meta as { align?: string })?.align;
                    return (
                      <th
                        key={header.id}
                        className={`text-xs text-foreground-muted border-b border-border py-3 px-4 font-medium ${
                          align === 'right' ? 'text-right' : ''
                        } ${header.column.getCanSort() ? 'cursor-pointer select-none hover:text-foreground transition-colors' : ''}`}
                        style={{ width: header.column.getSize() !== 150 ? header.column.getSize() : undefined }}
                        onClick={header.column.getCanSort() ? header.column.getToggleSortingHandler() : undefined}
                      >
                        {header.isPlaceholder ? null : (
                          <span className="inline-flex items-center">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {header.column.getCanSort() && (
                              <SortIcon direction={header.column.getIsSorted()} />
                            )}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map(row => (
                <tr
                  key={row.id}
                  onClick={() => setSelectedId(row.original.id)}
                  className={`border-b border-border/50 cursor-pointer transition-colors hover:bg-surface-hover/50 ${
                    row.getIsSelected() ? 'bg-primary/5' : ''
                  }`}
                >
                  {row.getVisibleCells().map(cell => {
                    const align = (cell.column.columnDef.meta as { align?: string })?.align;
                    return (
                      <td
                        key={cell.id}
                        className={`py-3 px-4 text-sm text-foreground ${
                          align === 'right' ? 'text-right font-mono tabular-nums' : ''
                        }`}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail panel */}
      {selectedId !== null && (
        <PayslipDetailPanel
          payslipId={selectedId}
          onClose={() => setSelectedId(null)}
          onUpdated={fetchPayslips}
        />
      )}
    </div>
  );
}
