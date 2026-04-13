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
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { Modal } from '@/components/ui/Modal';

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
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showBulkPost, setShowBulkPost] = useState(false);
  const [bulkPostAccountGuid, setBulkPostAccountGuid] = useState('');
  const [bulkPosting, setBulkPosting] = useState(false);
  const [bulkPostResults, setBulkPostResults] = useState<string | null>(null);

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
    setDeleting(true);
    try {
      await Promise.all(ids.map(id => fetch(`/api/payslips/${id}`, { method: 'DELETE' })));
      setRowSelection({});
      fetchPayslips();
    } catch (err) {
      console.error('Bulk delete failed:', err);
    } finally {
      setDeleting(false);
      setShowBulkDeleteConfirm(false);
    }
  }, [rowSelection, fetchPayslips]);

  const handleBulkPost = useCallback(async () => {
    if (!bulkPostAccountGuid) return;
    setBulkPosting(true);
    setBulkPostResults(null);

    const ids = Object.keys(rowSelection).map(Number);
    // Get currency guid from accounts API
    let currencyGuid = '';
    try {
      const accRes = await fetch('/api/accounts?flat=true&noBalances=true');
      const accounts = await accRes.json();
      currencyGuid = accounts[0]?.commodity_guid || '';
    } catch { /* continue with empty */ }

    let posted = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const id of ids) {
      try {
        const res = await fetch(`/api/payslips/${id}/post`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deposit_account_guid: bulkPostAccountGuid,
            currency_guid: currencyGuid,
          }),
        });
        if (res.ok) {
          posted++;
        } else {
          const data = await res.json();
          failed++;
          errors.push(`#${id}: ${data.error || 'Failed'}`);
        }
      } catch (err) {
        failed++;
        errors.push(`#${id}: ${err instanceof Error ? err.message : 'Failed'}`);
      }
    }

    setBulkPostResults(
      `Posted ${posted} payslip${posted !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}${errors.length > 0 ? `\n${errors.join('\n')}` : ''}`
    );
    setBulkPosting(false);
    setRowSelection({});
    fetchPayslips();
  }, [rowSelection, bulkPostAccountGuid, fetchPayslips]);

  const postableCount = useMemo(() => {
    return Object.keys(rowSelection)
      .map(id => payslips.find(p => p.id === Number(id)))
      .filter(p => p && (p.status === 'ready' || p.status === 'needs_mapping'))
      .length;
  }, [rowSelection, payslips]);

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
          <div className="ml-auto flex items-center gap-2">
            {postableCount > 0 && (
              <button
                onClick={() => setShowBulkPost(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-colors"
              >
                Post {postableCount} selected
              </button>
            )}
            <button
              onClick={() => setShowBulkDeleteConfirm(true)}
              disabled={deleting}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 disabled:opacity-40 transition-colors"
            >
              {deleting ? 'Deleting...' : `Delete ${selectedCount} selected`}
            </button>
          </div>
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

      {/* Bulk post dialog */}
      <Modal
        isOpen={showBulkPost}
        onClose={() => { setShowBulkPost(false); setBulkPostResults(null); }}
        title="Post Selected Payslips"
        size="md"
      >
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-foreground-secondary">
            Select the deposit account (bank account where net pay is deposited) for {postableCount} payslip{postableCount !== 1 ? 's' : ''}.
            Payslips with matching SimpleFin deposits will be linked automatically.
          </p>

          <div>
            <label className="text-xs text-foreground-muted block mb-1">Deposit Account</label>
            <AccountSelector
              value={bulkPostAccountGuid}
              onChange={setBulkPostAccountGuid}
              placeholder="Select bank account..."
              accountTypes={['BANK', 'CREDIT']}
            />
          </div>

          {bulkPostResults && (
            <div className={`text-sm rounded-lg px-3 py-2 whitespace-pre-line ${
              bulkPostResults.includes('failed') ? 'bg-yellow-500/10 text-yellow-400' : 'bg-primary/10 text-primary'
            }`}>
              {bulkPostResults}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
          <button
            onClick={() => { setShowBulkPost(false); setBulkPostResults(null); }}
            className="px-4 py-2 text-sm font-medium text-foreground-secondary bg-background-tertiary border border-border-hover rounded-lg hover:bg-surface-hover hover:text-foreground transition-colors"
          >
            {bulkPostResults ? 'Close' : 'Cancel'}
          </button>
          {!bulkPostResults && (
            <button
              onClick={handleBulkPost}
              disabled={!bulkPostAccountGuid || bulkPosting}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-primary hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
            >
              {bulkPosting && (
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {bulkPosting ? 'Posting...' : `Post ${postableCount} Payslips`}
            </button>
          )}
        </div>
      </Modal>

      <ConfirmationDialog
        isOpen={showBulkDeleteConfirm}
        onConfirm={handleBulkDelete}
        onCancel={() => setShowBulkDeleteConfirm(false)}
        title="Delete Payslips"
        message={`Are you sure you want to delete ${selectedCount} payslip${selectedCount > 1 ? 's' : ''}? Uploaded PDFs and extracted data will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        isLoading={deleting}
      />
    </div>
  );
}
