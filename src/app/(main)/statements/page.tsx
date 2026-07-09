'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { useToast } from '@/contexts/ToastContext';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { formatAccountPath } from '@/lib/account-utils';
import { formatCurrency } from '@/lib/format';
import { statusBadge, sourceBadge, isPollingStatus } from './statement-ui';

// ---------------------------------------------------------------------------
// Types (subset of GET /api/statements contract)
// ---------------------------------------------------------------------------

interface Batch {
  id: number;
  bookGuid: string;
  accountGuid: string | null;
  source: 'pdf' | 'csv' | 'ofx';
  originalFilename: string;
  status: string;
  statementStartDate: string | null;
  statementEndDate: string | null;
  openingBalance: number | string | null;
  closingBalance: number | string | null;
  currency: string | null;
  error: string | null;
  createdAt: string;
  lineCount: number;
}

// Reconcilable ledger accounts: banks, cash, plain assets, and credit cards.
const RECONCILE_ACCOUNT_TYPES = ['BANK', 'CASH', 'ASSET', 'CREDIT', 'LIABILITY'];
const MAX_FILE_SIZE = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function formatBalance(value: number | string | null, currency: string | null): string {
  if (value === null || value === undefined || value === '') return '—';
  return formatCurrency(value, currency || 'USD');
}

// ---------------------------------------------------------------------------
// Upload modal
// ---------------------------------------------------------------------------

function UploadModal({
  isOpen,
  onClose,
  onUploaded,
}: {
  isOpen: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [accountGuid, setAccountGuid] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset when opened.
  useEffect(() => {
    if (isOpen) {
      setFile(null);
      setAccountGuid('');
      setError(null);
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [isOpen]);

  const canSubmit = !!file && !!accountGuid && !uploading;

  const handleSubmit = useCallback(async () => {
    if (!file) {
      setError('Choose a statement file (PDF, CSV, or OFX/QFX).');
      return;
    }
    if (!accountGuid) {
      setError('Select the ledger account this statement reconciles.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError('File exceeds the 15MB limit.');
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('accountGuid', accountGuid);
      const res = await fetch('/api/statements/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
      }
      toast.success('Statement uploaded. Parsing…');
      onUploaded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [file, accountGuid, toast, onUploaded, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Upload Statement" size="md">
      <div className="px-6 py-5 space-y-5">
        {/* File input */}
        <div>
          <label className="block text-xs font-medium text-foreground-muted uppercase tracking-wider mb-1.5">
            Statement File
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.csv,.ofx,.qfx"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
            className="block w-full text-sm text-foreground-secondary file:mr-3 file:rounded-lg file:border file:border-border file:bg-background-tertiary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-surface-hover file:transition-colors file:cursor-pointer"
          />
          <p className="text-xs text-foreground-muted mt-1.5">
            PDF, CSV, or OFX/QFX. Max 15MB.
          </p>
        </div>

        {/* Account selector (required) */}
        <div>
          <label className="block text-xs font-medium text-foreground-muted uppercase tracking-wider mb-1.5">
            Reconcile Account <span className="text-[color:var(--warning)]">*</span>
          </label>
          <AccountSelector
            value={accountGuid}
            onChange={(guid) => {
              setAccountGuid(guid);
              setError(null);
            }}
            placeholder="Select bank / asset / credit account…"
            accountTypes={RECONCILE_ACCOUNT_TYPES}
            hasError={!!error && !accountGuid}
          />
          <p className="text-xs text-foreground-muted mt-1.5">
            Required — the ledger account this statement will be reconciled against.
          </p>
        </div>

        {error && (
          <div className="text-sm rounded-lg px-3 py-2 bg-[color:var(--negative)]/10 text-[color:var(--negative)] border border-[color:var(--negative)]/30">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
        <button
          onClick={onClose}
          disabled={uploading}
          className="px-4 py-2 text-sm font-medium text-foreground-secondary bg-background-tertiary border border-border-hover rounded-lg hover:bg-surface-hover hover:text-foreground disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-4 py-2 text-sm font-medium text-primary-foreground rounded-lg bg-primary hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
        >
          {uploading && (
            <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
          )}
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function StatementsPage() {
  const router = useRouter();
  const toast = useToast();
  const { data: accounts } = useAccounts({ flat: true });
  const accountNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of (accounts ?? []) as Array<{ guid: string; fullname?: string; name: string }>) {
      map.set(a.guid, formatAccountPath(a.fullname, a.name));
    }
    return map;
  }, [accounts]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Batch | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchBatches = useCallback(async () => {
    try {
      const res = await fetch('/api/statements');
      if (!res.ok) throw new Error('Failed to load statements');
      const data = await res.json();
      setBatches(Array.isArray(data.batches) ? data.batches : []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load statements');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBatches();
  }, [fetchBatches]);

  // Poll while any batch is still parsing.
  const anyParsing = useMemo(() => batches.some((b) => isPollingStatus(b.status)), [batches]);
  useEffect(() => {
    if (!anyParsing) return;
    const interval = setInterval(fetchBatches, 2500);
    return () => clearInterval(interval);
  }, [anyParsing, fetchBatches]);

  // '/' focuses the search box.
  useKeyboardShortcut(
    'statements-focus-search',
    '/',
    'Search statements',
    () => searchRef.current?.focus(),
    'page',
    !showUpload && !deleteTarget,
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return batches;
    return batches.filter(
      (b) =>
        b.originalFilename.toLowerCase().includes(q) ||
        (b.accountGuid ? (accountNames.get(b.accountGuid) ?? '').toLowerCase().includes(q) : false) ||
        b.source.toLowerCase().includes(q) ||
        b.status.toLowerCase().includes(q),
    );
  }, [batches, search, accountNames]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/statements/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast.success('Statement deleted');
      setDeleteTarget(null);
      fetchBatches();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, toast, fetchBatches]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <PageHeader
        title="Statements"
        subtitle="Import bank, credit, and brokerage statements, then reconcile them against your ledger."
        actions={
          <button
            onClick={() => setShowUpload(true)}
            className="bg-primary text-primary-foreground hover:bg-primary-hover rounded-lg px-4 py-2 text-sm font-medium transition-colors"
          >
            Upload Statement
          </button>
        }
      />

      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search statements…  ( / )"
          className="bg-input-bg border border-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder-foreground-muted focus:ring-2 focus:ring-primary/40 focus:outline-none w-64"
        />
        {!loading && (
          <span className="text-sm text-foreground-muted">
            {filtered.length} {filtered.length === 1 ? 'statement' : 'statements'}
          </span>
        )}
      </div>

      {/* Table / states */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-3 text-sm text-foreground-muted">
            <span className="w-4 h-4 border-2 border-foreground-muted/30 border-t-foreground-muted rounded-full animate-spin" />
            Loading statements…
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <span className="text-sm text-[color:var(--negative)]">{loadError}</span>
            <button
              onClick={() => { setLoading(true); fetchBatches(); }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-foreground-secondary hover:bg-surface-hover hover:text-foreground transition-colors"
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-center px-6">
            <span className="text-sm text-foreground-secondary">
              {batches.length === 0 ? 'No statements yet.' : 'No statements match your search.'}
            </span>
            {batches.length === 0 && (
              <button
                onClick={() => setShowUpload(true)}
                className="mt-1 text-sm text-primary hover:text-primary-hover transition-colors"
              >
                Upload your first statement
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left border-b border-border">
                  <th className="text-xs text-foreground-muted font-medium py-2.5 px-4">File</th>
                  <th className="text-xs text-foreground-muted font-medium py-2.5 px-4">Source</th>
                  <th className="text-xs text-foreground-muted font-medium py-2.5 px-4">Account</th>
                  <th className="text-xs text-foreground-muted font-medium py-2.5 px-4">Period</th>
                  <th className="text-xs text-foreground-muted font-medium py-2.5 px-4 text-right">Closing</th>
                  <th className="text-xs text-foreground-muted font-medium py-2.5 px-4">Status</th>
                  <th className="text-xs text-foreground-muted font-medium py-2.5 px-4 text-right">Lines</th>
                  <th className="text-xs text-foreground-muted font-medium py-2.5 px-4">Created</th>
                  <th className="py-2.5 px-4" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => {
                  const st = statusBadge(b.status);
                  const src = sourceBadge(b.source);
                  return (
                    <tr
                      key={b.id}
                      onClick={() => router.push(`/statements/${b.id}`)}
                      className="border-b border-border/50 last:border-0 cursor-pointer transition-colors hover:bg-surface-hover/50"
                    >
                      <td className="py-2.5 px-4 text-foreground max-w-[220px] truncate" title={b.originalFilename}>
                        {b.originalFilename}
                      </td>
                      <td className="py-2.5 px-4">
                        <Badge label={src.label} className={src.className} />
                      </td>
                      <td className="py-2.5 px-4 text-foreground-secondary max-w-[200px] truncate" title={b.accountGuid ? accountNames.get(b.accountGuid) ?? '' : ''}>
                        {b.accountGuid
                          ? accountNames.get(b.accountGuid) ?? '—'
                          : <span className="text-foreground-muted">Unassigned</span>}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-foreground-secondary whitespace-nowrap">
                        {formatPeriod(b.statementStartDate, b.statementEndDate)}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-right text-foreground whitespace-nowrap">
                        {formatBalance(b.closingBalance, b.currency)}
                      </td>
                      <td className="py-2.5 px-4">
                        <span className="inline-flex items-center gap-1.5">
                          {isPollingStatus(b.status) && (
                            <span className="w-3 h-3 border-2 border-foreground-muted/30 border-t-foreground-muted rounded-full animate-spin" />
                          )}
                          <Badge label={st.label} className={st.className} />
                        </span>
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-right text-foreground-secondary">
                        {b.lineCount}
                      </td>
                      <td className="py-2.5 px-4 font-mono tabular-nums text-foreground-muted whitespace-nowrap">
                        {formatDate(b.createdAt)}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(b); }}
                          className="text-xs font-medium text-foreground-muted hover:text-[color:var(--negative)] transition-colors"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <UploadModal isOpen={showUpload} onClose={() => setShowUpload(false)} onUploaded={fetchBatches} />

      <ConfirmationDialog
        isOpen={!!deleteTarget}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        title="Delete Statement"
        message={`Delete "${deleteTarget?.originalFilename ?? ''}"? The uploaded file and its parsed lines will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        isLoading={deleting}
      />
    </div>
  );
}
