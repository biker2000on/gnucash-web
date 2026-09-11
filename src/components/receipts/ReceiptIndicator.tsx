'use client';

import { useEffect, useState } from 'react';
import { ReceiptModal } from './ReceiptModal';
import { Tip } from '@/components/ui/Tooltip';

interface ReceiptIndicatorProps {
  transactionGuid: string;
  transactionDescription?: string;
  receiptCount?: number;
}

export function ReceiptIndicator({ transactionGuid, transactionDescription, receiptCount }: ReceiptIndicatorProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const [count, setCount] = useState(receiptCount);

  const [previousInput, setPreviousInput] = useState({ transactionGuid, receiptCount });
  if (previousInput.transactionGuid !== transactionGuid || previousInput.receiptCount !== receiptCount) {
    setPreviousInput({ transactionGuid, receiptCount });
    setCount(receiptCount);
  }

  useEffect(() => {
    if (receiptCount !== undefined) return;
    let cancelled = false;
    fetch(`/api/transactions/${transactionGuid}/receipts`)
      .then(async response => {
        if (!response.ok) return;
        const receipts = await response.json();
        if (!cancelled) setCount(receipts.length);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [transactionGuid, receiptCount]);

  useEffect(() => {
    const onReceiptsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ transactionGuid: string; count: number }>).detail;
      if (detail.transactionGuid === transactionGuid) setCount(detail.count);
    };
    window.addEventListener('gnucash:receipts-changed', onReceiptsChanged);
    return () => window.removeEventListener('gnucash:receipts-changed', onReceiptsChanged);
  }, [transactionGuid]);

  const label = count === undefined ? 'Receipts' : count > 0
    ? `${count} receipt${count !== 1 ? 's' : ''} attached`
    : 'Attach receipt';

  return (
    <>
      <Tip content={label} describedBy={false}>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setIsModalOpen(true); }}
        className="p-1 rounded hover:bg-surface-hover transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center gap-1 text-xs text-primary whitespace-nowrap"
        aria-label={label}
      >
        <span className="relative inline-flex shrink-0">
        {(count ?? 0) > 0 ? (
          <svg className="w-4 h-4 text-primary" fill="currentColor" viewBox="0 0 24 24">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-foreground-secondary opacity-40" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {(count ?? 0) > 0 && (
          <span aria-hidden="true" className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-0.5 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-surface">
            {count}
          </span>
        )}
        </span>
        {receiptCount === undefined && !count && <span>{label}</span>}
      </button>
      </Tip>

      <ReceiptModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        transactionGuid={transactionGuid}
        transactionDescription={transactionDescription}
      />
    </>
  );
}
