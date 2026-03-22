'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ReceiptModal } from './ReceiptModal';
import { ReceiptUploadZone } from './ReceiptUploadZone';
import { ReceiptInbox } from './ReceiptInbox';
import { useToast } from '@/contexts/ToastContext';
import type { ReceiptWithTransaction } from '@/lib/receipts';

const PAGE_SIZE = 30;

type GalleryTab = 'all' | 'linked' | 'inbox';

export function ReceiptGallery() {
  const [receipts, setReceipts] = useState<ReceiptWithTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [activeTab, setActiveTab] = useState<GalleryTab>('all');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptWithTransaction | null>(null);
  const [batchUploadOpen, setBatchUploadOpen] = useState(false);
  const observerTarget = useRef<HTMLDivElement>(null);
  const toast = useToast();

  // Map tab to linkedFilter param
  const linkedFilter = activeTab === 'linked' ? 'linked' : '';

  // Use ref to avoid stale closure in IntersectionObserver callback
  const fetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchReceipts = useCallback(async (reset: boolean = false) => {
    if (activeTab === 'inbox') return; // Inbox has its own fetch logic
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
  }, [activeTab, debouncedSearch, linkedFilter, offset, toast]);

  // Keep fetchRef current so IntersectionObserver always calls the latest version
  useEffect(() => {
    fetchRef.current = () => fetchReceipts(false);
  }, [fetchReceipts]);

  // Reset on filter/tab change
  useEffect(() => {
    if (activeTab !== 'inbox') {
      fetchReceipts(true);
    }
  }, [debouncedSearch, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Infinite scroll — uses ref to avoid stale closure
  useEffect(() => {
    if (!observerTarget.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && hasMore) {
          fetchRef.current();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [hasMore, loading]);

  return (
    <div className="space-y-4">
      {/* Tab bar + Batch Upload */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          {(['all', 'linked', 'inbox'] as GalleryTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 capitalize transition-colors min-h-[44px] ${
                activeTab === tab
                  ? 'bg-emerald-600 text-white font-medium'
                  : 'bg-background text-foreground-secondary hover:bg-surface-hover hover:text-foreground'
              }`}
            >
              {tab === 'inbox' ? 'Inbox' : tab === 'linked' ? 'Linked' : 'All'}
            </button>
          ))}
        </div>
        <button
          onClick={() => setBatchUploadOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium transition-colors min-h-[44px]"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          Batch Upload
        </button>
      </div>

      {/* Search bar (visible on All and Linked tabs) */}
      {activeTab !== 'inbox' && (
        <input
          type="search"
          placeholder="Search receipt text..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder-foreground-secondary focus:outline-none focus:border-emerald-500"
        />
      )}

      {/* Inbox tab */}
      {activeTab === 'inbox' && <ReceiptInbox />}

      {/* Gallery count (All / Linked tabs) */}
      {activeTab !== 'inbox' && (
        <p className="text-sm text-foreground-secondary">{total} receipt{total !== 1 ? 's' : ''}</p>
      )}

      {activeTab !== 'inbox' && receipts.length === 0 && !loading && (
        <div className="text-center py-16 text-foreground-secondary">
          <p>No receipts yet. Attach one from any transaction.</p>
        </div>
      )}

      {activeTab !== 'inbox' && receipts.length > 0 && (
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

      {activeTab !== 'inbox' && hasMore && <div ref={observerTarget} className="h-8" />}

      {activeTab !== 'inbox' && loading && (
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

      {/* Batch Upload modal */}
      <Modal
        isOpen={batchUploadOpen}
        onClose={() => setBatchUploadOpen(false)}
        title="Batch Upload Receipts"
        size="md"
      >
        <div className="p-4">
          <ReceiptUploadZone
            onUploadComplete={() => {
              setBatchUploadOpen(false);
              if (activeTab !== 'inbox') fetchReceipts(true);
            }}
          />
        </div>
      </Modal>
    </div>
  );
}
