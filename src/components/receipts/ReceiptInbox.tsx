'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { TransactionPicker } from './TransactionPicker';

interface ExtractedData {
  amount: number | null;
  currency: string;
  date: string | null;
  vendor: string | null;
}

interface MatchCandidate {
  guid: string;
  description: string;
  post_date: string;
  amount: string;
  score: number;
}

interface InboxReceipt {
  id: number;
  filename: string;
  thumbnail_key: string | null;
  extracted_data: ExtractedData | null;
  ocr_status: string;
  created_at: string;
  match_candidates: MatchCandidate[];
}

function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const colorClass =
    pct >= 80
      ? 'text-primary bg-primary/10'
      : pct >= 50
      ? 'text-yellow-400 bg-yellow-500/10'
      : 'text-foreground-secondary bg-surface-hover';
  return (
    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${colorClass}`}>
      {pct}%
    </span>
  );
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

interface InboxCardProps {
  receipt: InboxReceipt;
  onLinked: (id: number) => void;
  onDismissed: (id: number, guid: string) => void;
}

function InboxCard({ receipt, onLinked, onDismissed }: InboxCardProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [linking, setLinking] = useState(false);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const candidates = receipt.match_candidates;
  const topCandidate = candidates[0] ?? null;
  const visibleCandidates = expanded ? candidates : candidates.slice(0, 1);

  const handleLink = useCallback(
    async (transactionGuid: string) => {
      setLinking(true);
      try {
        const res = await fetch(`/api/receipts/${receipt.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_guid: transactionGuid }),
        });
        if (!res.ok) throw new Error('Failed to link');
        toast.success('Receipt linked successfully');
        onLinked(receipt.id);
      } catch {
        toast.error('Failed to link receipt');
      } finally {
        setLinking(false);
      }
    },
    [receipt.id, toast, onLinked]
  );

  const handleDismiss = useCallback(
    async (transactionGuid: string) => {
      setDismissing(transactionGuid);
      try {
        const res = await fetch(`/api/receipts/${receipt.id}/dismiss`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_guid: transactionGuid }),
        });
        if (!res.ok) throw new Error('Failed to dismiss');
        onDismissed(receipt.id, transactionGuid);
      } catch {
        toast.error('Failed to dismiss match');
      } finally {
        setDismissing(null);
      }
    },
    [receipt.id, toast, onDismissed]
  );

  const handleManualLink = useCallback(
    (guid: string) => {
      handleLink(guid);
    },
    [handleLink]
  );

  const extracted = receipt.extracted_data;

  return (
    <div className="bg-background border border-border rounded-xl overflow-hidden">
      <div className="flex gap-3 p-3">
        {/* Thumbnail */}
        <div className="w-16 h-16 shrink-0 rounded-lg overflow-hidden bg-surface-hover flex items-center justify-center">
          {receipt.thumbnail_key ? (
            <img
              src={`/api/receipts/${receipt.id}/thumbnail`}
              alt={receipt.filename}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <svg
              className="w-8 h-8 text-foreground-secondary"
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
              />
            </svg>
          )}
        </div>

        {/* Extracted info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{receipt.filename}</p>
          {extracted ? (
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-foreground-secondary">
              {extracted.amount != null && (
                <span>
                  {extracted.currency} {extracted.amount.toFixed(2)}
                </span>
              )}
              {extracted.date && <span>{formatDate(extracted.date)}</span>}
              {extracted.vendor && <span className="truncate max-w-[150px]">{extracted.vendor}</span>}
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-foreground-secondary">
              {receipt.ocr_status === 'pending'
                ? 'Extracting data...'
                : receipt.ocr_status === 'failed'
                ? 'Extraction failed'
                : 'No data extracted'}
            </p>
          )}
        </div>
      </div>

      {/* Match candidates */}
      {candidates.length === 0 ? (
        <div className="px-3 pb-3">
          <p className="text-xs text-foreground-secondary italic">No matching transactions found.</p>
          <button
            onClick={() => setPickerOpen(true)}
            className="mt-2 w-full text-sm px-3 py-2 bg-surface-hover hover:bg-border rounded-lg transition-colors min-h-[44px] text-foreground"
          >
            Link manually
          </button>
        </div>
      ) : (
        <div className="border-t border-border divide-y divide-border">
          {visibleCandidates.map((candidate) => (
            <div key={candidate.guid} className="flex items-center gap-2 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <ScoreBadge score={candidate.score} />
                  <span className="text-sm text-foreground truncate">{candidate.description || '(no description)'}</span>
                </div>
                <p className="text-xs text-foreground-secondary mt-0.5">
                  {formatDate(candidate.post_date)}
                  {candidate.amount && ` · ${candidate.amount}`}
                </p>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => handleDismiss(candidate.guid)}
                  disabled={dismissing === candidate.guid || linking}
                  className="text-xs px-2 py-1.5 rounded-lg bg-surface-hover hover:bg-border transition-colors text-foreground-secondary min-h-[36px] disabled:opacity-50"
                  title="Not this transaction"
                >
                  {dismissing === candidate.guid ? (
                    <span className="animate-spin inline-block w-3 h-3 border border-current border-t-transparent rounded-full" />
                  ) : (
                    'Not this'
                  )}
                </button>
                <button
                  onClick={() => handleLink(candidate.guid)}
                  disabled={linking || dismissing !== null}
                  className="text-xs px-2 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-primary-foreground transition-colors min-h-[36px] disabled:opacity-50 font-medium"
                >
                  {linking ? (
                    <span className="animate-spin inline-block w-3 h-3 border border-white border-t-transparent rounded-full" />
                  ) : (
                    'Link'
                  )}
                </button>
              </div>
            </div>
          ))}

          {/* More / Link manually row */}
          <div className="px-3 py-2 flex gap-2">
            {candidates.length > 1 && (
              <button
                onClick={() => setExpanded((e) => !e)}
                className="text-xs px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-border transition-colors text-foreground-secondary min-h-[36px]"
              >
                {expanded ? 'Show less' : `More (${candidates.length - 1})`}
              </button>
            )}
            <button
              onClick={() => setPickerOpen(true)}
              className="text-xs px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-border transition-colors text-foreground-secondary min-h-[36px] ml-auto"
            >
              Link manually
            </button>
          </div>
        </div>
      )}

      <TransactionPicker
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleManualLink}
      />
    </div>
  );
}

export function ReceiptInbox() {
  const toast = useToast();
  const [receipts, setReceipts] = useState<InboxReceipt[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchInbox = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/receipts/inbox');
      if (!res.ok) throw new Error('Failed to fetch inbox');
      const data = await res.json();
      setReceipts(data.receipts ?? []);
    } catch {
      toast.error('Failed to load inbox');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchInbox();
  }, [fetchInbox]);

  const handleLinked = useCallback((id: number) => {
    setReceipts((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const handleDismissed = useCallback((id: number, transactionGuid: string) => {
    setReceipts((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        return {
          ...r,
          match_candidates: r.match_candidates.filter((c) => c.guid !== transactionGuid),
        };
      })
    );
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    );
  }

  if (receipts.length === 0) {
    return (
      <div className="text-center py-16 text-foreground-secondary">
        <svg
          className="w-12 h-12 mx-auto mb-3 opacity-40"
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="font-medium">Inbox is empty</p>
        <p className="text-sm mt-1">All receipts have been linked to transactions.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-foreground-secondary">
        {receipts.length} unlinked receipt{receipts.length !== 1 ? 's' : ''}
      </p>
      {receipts.map((receipt) => (
        <InboxCard
          key={receipt.id}
          receipt={receipt}
          onLinked={handleLinked}
          onDismissed={handleDismissed}
        />
      ))}
    </div>
  );
}
