'use client';

import { useState, useEffect, useCallback } from 'react';
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

type StatusFilter = 'all' | 'processing' | 'needs_mapping' | 'ready' | 'posted' | 'error';

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
// Page component
// ---------------------------------------------------------------------------

export default function PayslipsPage() {
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);

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

  useEffect(() => {
    fetchPayslips();
  }, [fetchPayslips]);

  const handleUploadComplete = useCallback(() => {
    fetchPayslips();
    setShowUpload(false);
  }, [fetchPayslips]);

  const filtered =
    statusFilter === 'all'
      ? payslips
      : payslips.filter(p => p.status === statusFilter);

  function formatAmount(amount: number | null | undefined): string {
    if (amount == null) return '—';
    return '$' + Number(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

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
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:ring-2 focus:ring-primary/40 focus:outline-none"
        >
          <option value="all">All</option>
          <option value="processing">Processing</option>
          <option value="needs_mapping">Needs Mapping</option>
          <option value="ready">Ready</option>
          <option value="posted">Posted</option>
          <option value="error">Error</option>
        </select>

        {!loading && (
          <span className="text-sm text-foreground-muted">
            {filtered.length} {filtered.length === 1 ? 'payslip' : 'payslips'}
          </span>
        )}
      </div>

      {/* Table */}
      <div className="bg-surface/30 backdrop-blur-xl rounded-2xl border border-border overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <span className="text-sm text-foreground-muted">Loading...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <span className="text-sm text-foreground-muted">
              {statusFilter === 'all'
                ? 'No payslips yet. Upload one to get started.'
                : `No payslips with status "${STATUS_LABELS[statusFilter] ?? statusFilter}".`}
            </span>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-left">
                <th className="text-xs text-foreground-muted border-b border-border py-3 px-4 font-medium">
                  Pay Date
                </th>
                <th className="text-xs text-foreground-muted border-b border-border py-3 px-4 font-medium">
                  Employer
                </th>
                <th className="text-xs text-foreground-muted border-b border-border py-3 px-4 font-medium text-right">
                  Gross
                </th>
                <th className="text-xs text-foreground-muted border-b border-border py-3 px-4 font-medium text-right">
                  Net
                </th>
                <th className="text-xs text-foreground-muted border-b border-border py-3 px-4 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(payslip => (
                <tr
                  key={payslip.id}
                  onClick={() => setSelectedId(payslip.id)}
                  className="border-b border-border/50 cursor-pointer transition-colors hover:bg-surface-hover/50"
                >
                  <td className="py-3 px-4 text-sm text-foreground">
                    {new Date(payslip.pay_date).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4 text-sm text-foreground">
                    {payslip.employer_name}
                  </td>
                  <td className="py-3 px-4 text-sm font-mono tabular-nums text-foreground text-right">
                    {formatAmount(payslip.gross_pay)}
                  </td>
                  <td className="py-3 px-4 text-sm font-mono tabular-nums text-foreground text-right">
                    {formatAmount(payslip.net_pay)}
                  </td>
                  <td className="py-3 px-4">
                    <StatusBadge status={payslip.status} />
                  </td>
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
