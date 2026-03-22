'use client';

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { ReceiptUploadZone } from './ReceiptUploadZone';
import { useToast } from '@/contexts/ToastContext';
import type { Receipt } from '@/lib/receipts';

interface ReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
  transactionGuid: string;
  transactionDescription?: string;
}

export function ReceiptModal({ isOpen, onClose, transactionGuid, transactionDescription }: ReceiptModalProps) {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<'view' | 'upload'>('view');
  const [loading, setLoading] = useState(true);
  const [showOcr, setShowOcr] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const toast = useToast();

  const fetchReceipts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/transactions/${transactionGuid}/receipts`);
      if (res.ok) {
        const data = await res.json();
        setReceipts(data);
        setActiveTab(data.length > 0 ? 'view' : 'upload');
        setActiveIndex(0);
      } else if (res.status === 401 || res.status === 403) {
        toast.error('Not authorized to view receipts');
      }
    } catch {
      toast.error('Failed to load receipts');
    } finally {
      setLoading(false);
    }
  }, [transactionGuid, toast]);

  useEffect(() => {
    if (isOpen) fetchReceipts();
  }, [isOpen, fetchReceipts]);

  const handleDelete = async () => {
    const receipt = receipts[activeIndex];
    if (!receipt) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`/api/receipts/${receipt.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Receipt deleted');
        setShowDeleteConfirm(false);
        fetchReceipts();
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to delete');
      }
    } catch {
      toast.error('Failed to delete receipt');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleUploadComplete = () => {
    toast.success('Receipt(s) uploaded');
    fetchReceipts();
  };

  const activeReceipt = receipts[activeIndex];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={transactionDescription || 'Receipt'} size="lg">
      <div className="flex flex-col h-full">
        {/* Tab bar */}
        <div className="flex border-b border-border px-4">
          <button
            onClick={() => setActiveTab('view')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'view'
                ? 'border-emerald-500 text-emerald-500'
                : 'border-transparent text-foreground-secondary hover:text-foreground'
            }`}
          >
            View ({receipts.length})
          </button>
          <button
            onClick={() => setActiveTab('upload')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'upload'
                ? 'border-emerald-500 text-emerald-500'
                : 'border-transparent text-foreground-secondary hover:text-foreground'
            }`}
          >
            Upload
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'upload' ? (
            <ReceiptUploadZone
              transactionGuid={transactionGuid}
              onUploadComplete={handleUploadComplete}
            />
          ) : loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500" />
            </div>
          ) : receipts.length === 0 ? (
            <div className="text-center py-16 text-foreground-secondary">
              <p>No receipts attached.</p>
              <button
                onClick={() => setActiveTab('upload')}
                className="mt-2 text-emerald-500 hover:text-emerald-400 text-sm"
              >
                Upload one
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Main receipt view */}
              {activeReceipt && (
                <div className="bg-black/20 rounded-xl overflow-hidden flex items-center justify-center min-h-[300px]">
                  {activeReceipt.mime_type === 'application/pdf' ? (
                    <iframe
                      src={`/api/receipts/${activeReceipt.id}`}
                      className="w-full h-[60vh] border-0"
                      title={activeReceipt.filename}
                    />
                  ) : (
                    <img
                      src={`/api/receipts/${activeReceipt.id}`}
                      alt={activeReceipt.filename}
                      className="max-w-full max-h-[60vh] object-contain"
                    />
                  )}
                </div>
              )}

              {/* Multi-receipt thumbnail strip */}
              {receipts.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {receipts.map((r, i) => (
                    <button
                      key={r.id}
                      onClick={() => setActiveIndex(i)}
                      className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${
                        i === activeIndex ? 'border-emerald-500' : 'border-border hover:border-emerald-400'
                      }`}
                    >
                      {r.thumbnail_key ? (
                        <img
                          src={`/api/receipts/${r.id}/thumbnail`}
                          alt={r.filename}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-surface-hover flex items-center justify-center text-xs text-foreground-secondary">
                          PDF
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Action buttons */}
              {activeReceipt && (
                <div className="flex gap-2">
                  <a
                    href={`/api/receipts/${activeReceipt.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm text-foreground transition-colors min-h-[44px]"
                  >
                    Open in Tab
                  </a>
                  <a
                    href={`/api/receipts/${activeReceipt.id}`}
                    download={activeReceipt.filename}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-surface-hover hover:bg-border rounded-lg text-sm text-foreground transition-colors min-h-[44px]"
                  >
                    Download
                  </a>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-sm transition-colors min-h-[44px]"
                  >
                    Delete
                  </button>
                </div>
              )}

              {/* OCR text (collapsible) */}
              {activeReceipt?.ocr_text && (
                <div>
                  <button
                    onClick={() => setShowOcr(!showOcr)}
                    className="flex items-center gap-1 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                  >
                    <svg
                      className={`w-4 h-4 transition-transform ${showOcr ? 'rotate-90' : ''}`}
                      fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    OCR Text
                  </button>
                  {showOcr && (
                    <pre className="mt-2 p-3 bg-black/20 rounded-lg text-xs text-foreground-secondary whitespace-pre-wrap max-h-48 overflow-y-auto">
                      {activeReceipt.ocr_text}
                    </pre>
                  )}
                </div>
              )}

              {activeReceipt?.ocr_status === 'processing' && (
                <p className="text-xs text-foreground-secondary">OCR processing...</p>
              )}
              {activeReceipt?.ocr_status === 'failed' && (
                <p className="text-xs text-red-400">OCR failed</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmationDialog
        isOpen={showDeleteConfirm}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
        title="Delete Receipt"
        message={`Are you sure you want to delete "${activeReceipt?.filename}"? This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        isLoading={isDeleting}
      />
    </Modal>
  );
}
