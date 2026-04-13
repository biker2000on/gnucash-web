'use client';

import { useState, useEffect, useCallback } from 'react';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { PayslipLineItemTable } from './PayslipLineItemTable';
import { TransactionPreview } from './TransactionPreview';
import type { PayslipLineItem } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PayslipDetailPanelProps {
  payslipId: number;
  onClose: () => void;
  onUpdated?: () => void;
}

interface MappingEntry {
  normalized_label: string;
  line_item_category: string;
  account_guid: string;
}

interface PayslipData {
  id: number;
  employer_name: string;
  pay_date: string;
  status: string;
  gross_pay: number | null;
  net_pay: number | null;
  storage_key: string | null;
  line_items: PayslipLineItem[] | null;
  currency?: string;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  posted: 'bg-teal-500/20 text-teal-400 border border-teal-500/30',
  ready: 'bg-green-500/20 text-green-400 border border-green-500/30',
  needs_mapping: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  processing: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  error: 'bg-red-500/20 text-red-400 border border-red-500/30',
};

const STATUS_LABELS: Record<string, string> = {
  posted: 'Posted',
  ready: 'Ready',
  needs_mapping: 'Needs Mapping',
  processing: 'Processing',
  error: 'Error',
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? 'bg-surface text-foreground-muted border border-border';
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={`px-2 py-1 rounded text-xs font-medium ${style}`}>{label}</span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PayslipDetailPanel({ payslipId, onClose, onUpdated }: PayslipDetailPanelProps) {
  const [payslip, setPayslip] = useState<PayslipData | null>(null);
  const [mappings, setMappings] = useState<MappingEntry[]>([]);
  const [depositAccountGuid, setDepositAccountGuid] = useState('');
  const [depositAccountName, setDepositAccountName] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [editableEmployerName, setEditableEmployerName] = useState('');

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Fetch payslip + mappings on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setFetchError(null);

      try {
        const payslipRes = await fetch(`/api/payslips/${payslipId}`);
        if (!payslipRes.ok) throw new Error('Failed to fetch payslip');
        const payslipData: PayslipData = await payslipRes.json();

        if (cancelled) return;
        setPayslip(payslipData);
        setEditableEmployerName(payslipData.employer_name || '');

        const mappingsRes = await fetch(
          `/api/payslips/mappings?employer=${encodeURIComponent(payslipData.employer_name)}`
        );
        if (!mappingsRes.ok) throw new Error('Failed to fetch mappings');
        const mappingsData: MappingEntry[] = await mappingsRes.json();

        if (!cancelled) {
          setMappings(mappingsData);
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : 'Failed to load payslip');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, [payslipId]);

  // Handle mapping changes — update local state immediately AND PUT to API
  const handleMappingChange = useCallback(
    async (normalized_label: string, category: string, account_guid: string) => {
      if (!payslip) return;

      // Optimistic local update
      setMappings(prev => {
        const existing = prev.find(
          m => m.normalized_label === normalized_label && m.line_item_category === category
        );
        if (existing) {
          return prev.map(m =>
            m.normalized_label === normalized_label && m.line_item_category === category
              ? { ...m, account_guid }
              : m
          );
        }
        return [...prev, { normalized_label, line_item_category: category, account_guid }];
      });

      // Persist to API
      try {
        await fetch('/api/payslips/mappings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employer_name: payslip.employer_name,
            mappings: [{ normalized_label, line_item_category: category, account_guid }],
          }),
        });
      } catch (err) {
        console.error('Failed to save mapping:', err);
      }
    },
    [payslip]
  );

  const handleAddLineItem = useCallback(() => {
    if (!payslip) return;
    const newItem: PayslipLineItem = {
      category: 'earnings',
      label: '',
      normalized_label: '',
      amount: 0,
    };
    const updated = [...(payslip.line_items ?? []), newItem];
    setPayslip(prev => prev ? { ...prev, line_items: updated } : null);
  }, [payslip]);

  const handleRemoveLineItem = useCallback((index: number) => {
    if (!payslip) return;
    const updated = (payslip.line_items ?? []).filter((_, i) => i !== index);
    setPayslip(prev => prev ? { ...prev, line_items: updated } : null);
  }, [payslip]);

  const handleLineItemEdit = useCallback((index: number, field: string, value: unknown) => {
    if (!payslip) return;
    const items = [...(payslip.line_items ?? [])];
    items[index] = { ...items[index], [field]: value };
    setPayslip(prev => prev ? { ...prev, line_items: items } : null);
  }, [payslip]);

  const handleSaveLineItems = useCallback(async () => {
    if (!payslip) return;
    try {
      await fetch(`/api/payslips/${payslipId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          line_items: payslip.line_items,
          employer_name: editableEmployerName,
        }),
      });
    } catch (err) {
      console.error('Failed to save line items:', err);
    }
  }, [payslip, payslipId, editableEmployerName]);

  // Derived state
  const lineItems: PayslipLineItem[] = payslip?.line_items ?? [];

  const allNonEmployerMapped = lineItems
    .filter(item => item.category !== 'employer_contribution')
    .every(item => {
      const mapping = mappings.find(m => m.normalized_label === item.normalized_label && m.line_item_category === item.category);
      return mapping && mapping.account_guid;
    });

  const canPost =
    payslip?.status !== 'posted' &&
    allNonEmployerMapped &&
    !!depositAccountGuid &&
    lineItems.length > 0;

  // Build mappings dict for TransactionPreview: "category:normalized_label" -> account_guid
  const mappingsDict: Record<string, string> = {};
  for (const m of mappings) {
    mappingsDict[`${m.line_item_category}:${m.normalized_label}`] = m.account_guid;
  }

  // Build account names dict for TransactionPreview
  const accountNamesDict: Record<string, string> = {};
  if (depositAccountGuid && depositAccountName) {
    accountNamesDict[depositAccountGuid] = depositAccountName;
  }

  // Format pay date
  const formattedPayDate = payslip?.pay_date
    ? new Date(payslip.pay_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

  // Format currency amounts
  function formatAmount(amount: number | null | undefined): string {
    if (amount == null) return '—';
    return amount.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  // Post the payslip
  async function handlePost() {
    if (!canPost || !payslip) return;
    setPosting(true);
    setPostError(null);

    try {
      // Fetch accounts to get currency_guid
      const accRes = await fetch('/api/accounts');
      const accounts = await accRes.json();
      const currencyGuid = accounts[0]?.commodity_guid || '';

      const res = await fetch(`/api/payslips/${payslipId}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deposit_account_guid: depositAccountGuid,
          currency_guid: currencyGuid,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Failed to post payslip');
      }

      // Update local status to posted
      setPayslip(prev => prev ? { ...prev, status: 'posted' } : prev);
      onUpdated?.();
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Failed to post payslip');
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full sm:w-[600px] bg-background border-l border-border z-50 overflow-y-auto flex flex-col">
        {/* Sticky header */}
        <div className="sticky top-0 bg-background border-b border-border px-6 py-4 flex items-start justify-between gap-4 z-10">
          <div className="flex flex-col gap-1 min-w-0">
            {loading ? (
              <div className="h-5 w-48 bg-surface animate-pulse rounded" />
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  {payslip && payslip.status !== 'posted' ? (
                    <input
                      type="text"
                      value={editableEmployerName}
                      onChange={e => setEditableEmployerName(e.target.value)}
                      onBlur={handleSaveLineItems}
                      className="text-lg font-semibold text-foreground bg-transparent border-b border-border focus:border-primary focus:outline-none"
                      placeholder="Employer name"
                    />
                  ) : (
                    <span className="text-lg font-semibold text-foreground">
                      {payslip?.employer_name ?? 'Payslip'}
                    </span>
                  )}
                  {payslip && <StatusBadge status={payslip.status} />}
                </div>
                {formattedPayDate && (
                  <p className="text-sm text-foreground-muted">{formattedPayDate}</p>
                )}
              </>
            )}
          </div>

          <button
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            aria-label="Close panel"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 px-6 py-6 space-y-6">
          {/* Error state */}
          {fetchError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
              {fetchError}
            </div>
          )}

          {/* Loading skeleton */}
          {loading && !fetchError && (
            <div className="space-y-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-10 bg-surface animate-pulse rounded-lg" />
              ))}
            </div>
          )}

          {/* Main content */}
          {!loading && payslip && (
            <>
              {/* Gross / Net pay */}
              <div className="flex gap-6">
                <div>
                  <p className="text-sm font-semibold text-foreground-secondary mb-1">Gross Pay</p>
                  <p className="font-mono tabular-nums text-foreground text-lg">
                    {formatAmount(payslip.gross_pay ? Number(payslip.gross_pay) : null)}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground-secondary mb-1">Net Pay</p>
                  <p className="font-mono tabular-nums text-foreground text-lg">
                    {formatAmount(payslip.net_pay ? Number(payslip.net_pay) : null)}
                  </p>
                </div>
              </div>

              {/* PDF viewer */}
              {payslip.storage_key && (
                <div>
                  <p className="text-sm font-semibold text-foreground-secondary mb-2">Document</p>
                  <div className="rounded-lg overflow-hidden border border-border bg-surface">
                    <iframe
                      src={`/api/payslips/${payslip.id}?view=pdf`}
                      className="w-full h-[400px]"
                      title="Payslip PDF"
                    />
                  </div>
                </div>
              )}

              {/* Line items section */}
              {lineItems.length > 0 && (
                <div>
                  <p className="text-sm font-semibold text-foreground-secondary mb-3">Line Items</p>
                  <PayslipLineItemTable
                    lineItems={lineItems}
                    employerName={payslip.employer_name}
                    mappings={mappings}
                    onMappingChange={handleMappingChange}
                    editable={payslip.status !== 'posted'}
                    onLineItemEdit={handleLineItemEdit}
                    onAddLineItem={handleAddLineItem}
                    onRemoveLineItem={handleRemoveLineItem}
                  />
                </div>
              )}

              {lineItems.length === 0 && (
                <div className="text-sm text-foreground-muted italic">
                  No line items available for this payslip.
                </div>
              )}

              {/* Save changes button */}
              {payslip.status !== 'posted' && lineItems.length > 0 && (
                <button
                  onClick={handleSaveLineItems}
                  className="text-xs text-primary hover:text-primary-hover transition-colors"
                >
                  Save changes
                </button>
              )}

              {/* Deposit account selector */}
              {payslip.status !== 'posted' && (
                <div>
                  <p className="text-sm font-semibold text-foreground-secondary mb-2">Deposit Account</p>
                  <AccountSelector
                    value={depositAccountGuid}
                    onChange={(guid, name) => {
                      setDepositAccountGuid(guid);
                      setDepositAccountName(name);
                    }}
                    accountTypes={['BANK', 'CREDIT']}
                    placeholder="Select deposit account..."
                  />
                </div>
              )}

              {/* Transaction preview */}
              {canPost && payslip.net_pay != null && (
                <TransactionPreview
                  lineItems={lineItems}
                  mappings={mappingsDict}
                  accountNames={accountNamesDict}
                  depositAccountGuid={depositAccountGuid}
                  depositAccountName={depositAccountName}
                  netPay={Number(payslip.net_pay)}
                  employerName={payslip.employer_name}
                  payDate={payslip.pay_date}
                />
              )}

              {/* Post error */}
              {postError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg px-4 py-3 text-sm">
                  {postError}
                </div>
              )}

              {/* Post button */}
              {payslip.status !== 'posted' && (
                <div className="pt-2">
                  <button
                    onClick={handlePost}
                    disabled={!canPost || posting}
                    className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-background hover:bg-primary-hover disabled:opacity-40 transition-colors"
                  >
                    {posting ? 'Posting…' : 'Post Transaction'}
                  </button>
                  {!canPost && !posting && (
                    <p className="text-xs text-foreground-muted mt-2 text-center">
                      {!depositAccountGuid
                        ? 'Select a deposit account to post'
                        : !allNonEmployerMapped
                        ? 'Map all line items to accounts to post'
                        : lineItems.length === 0
                        ? 'No line items to post'
                        : ''}
                    </p>
                  )}
                </div>
              )}

              {/* Already posted indicator */}
              {payslip.status === 'posted' && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-teal-500/10 border border-teal-500/30 text-teal-400 text-sm">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>This payslip has been posted to GnuCash.</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default PayslipDetailPanel;
