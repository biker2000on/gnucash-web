'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ReceiptModal } from './ReceiptModal';
import { useToast } from '@/contexts/ToastContext';
import type { ReceiptWithTransaction } from '@/lib/receipts';

const PAGE_SIZE = 30;

export function ReceiptGallery() {
  const [receipts, setReceipts] = useState<ReceiptWithTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [linkedFilter, setLinkedFilter] = useState<'' | 'linked' | 'unlinked'>('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptWithTransaction | null>(null);
  const observerTarget = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchReceipts = useCallback(async (reset: boolean = false) => {
    const currentOffset = reset ? 0 : offset;
    setLoading(true);

    const params = new URLSearchParams({
      limit: PAGE_SIZE.toString(),
      offset: currentOffset.toString(),
    });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (linkedFilter) params.set('linked', linkedFilter);

    try {
      const res = await fetch(`/api/receipts?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();

      if (reset) {
        setReceipts(data.receipts);
      } else {
        setReceipts(prev => [...prev, ...data.receipts]);
      }
      setTotal(data.total);
      setHasMore(currentOffset + PAGE_SIZE < data.total);
      if (reset) setOffset(PAGE_SIZE);
      else setOffset(currentOffset + PAGE_SIZE);
    } catch {
      toast.error('Failed to load receipts');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, linkedFilter, offset, toast]);

  useEffect(() => {
    fetchReceipts(true);
  }, [debouncedSearch, linkedFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!observerTarget.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && hasMore) {
          fetchReceipts(false);
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [hasMore, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="search"
          placeholder="Search receipt text..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder-foreground-secondary focus:outline-none focus:border-emerald-500"
        />
        <select
          value={linkedFilter}
          onChange={(e) => setLinkedFilter(e.target.value as '' | 'linked' | 'unlinked')}
          className="px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-emerald-500"
        >
          <option value="">All receipts</option>
          <option value="linked">Linked to transaction</option>
          <option value="unlinked">Unlinked</option>
        </select>
      </div>

      <p className="text-sm text-foreground-secondary">{total} receipt{total !== 1 ? 's' : ''}</p>

      {receipts.length === 0 && !loading ? (
        <div className="text-center py-16 text-foreground-secondary">
          <p>No receipts yet. Attach one from any transaction.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {receipts.map((receipt) => (
            <button
              key={receipt.id}
              onClick={() => setSelectedReceipt(receipt)}
              className="group relative bg-surface-hover rounded-xl overflow-hidden aspect-square hover:ring-2 hover:ring-emerald-500 transition-all"
            >
              {receipt.thumbnail_key ? (
                <img
                  src={`/api/receipts/${receipt.id}/thumbnail`}
                  alt={receipt.filename}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-foreground-secondary">
                  <svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
              )}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                <p className="text-xs text-white truncate">{receipt.filename}</p>
                {receipt.transaction_description && (
                  <p className="text-xs text-white/70 truncate">{receipt.transaction_description}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {hasMore && <div ref={observerTarget} className="h-8" />}

      {loading && (
        <div className="flex justify-center py-4">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-emerald-500" />
        </div>
      )}

      {selectedReceipt && selectedReceipt.transaction_guid && (
        <ReceiptModal
          isOpen={true}
          onClose={() => setSelectedReceipt(null)}
          transactionGuid={selectedReceipt.transaction_guid}
          transactionDescription={selectedReceipt.transaction_description}
        />
      )}
      {selectedReceipt && !selectedReceipt.transaction_guid && (
        <Modal isOpen onClose={() => { setSelectedReceipt(null); fetchReceipts(true); }} title={selectedReceipt.filename} size="lg">
          <div className="p-4">
            {selectedReceipt.mime_type === 'application/pdf' ? (
              <iframe
                src={`/api/receipts/${selectedReceipt.id}`}
                className="w-full h-[60vh] border-0 rounded-lg"
                title={selectedReceipt.filename}
              />
            ) : (
              <img
                src={`/api/receipts/${selectedReceipt.id}`}
                alt={selectedReceipt.filename}
                className="max-w-full max-h-[60vh] object-contain mx-auto rounded-lg"
              />
            )}
            <div className="mt-4 flex gap-2">
              <a
                href={`/api/receipts/${selectedReceipt.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-center px-3 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm transition-colors min-h-[44px]"
              >
                Open in Tab
              </a>
              <a
                href={`/api/receipts/${selectedReceipt.id}`}
                download={selectedReceipt.filename}
                className="flex-1 text-center px-3 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm transition-colors min-h-[44px]"
              >
                Download
              </a>
            </div>
            <p className="mt-3 text-xs text-foreground-secondary">
              This receipt is not linked to a transaction.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
