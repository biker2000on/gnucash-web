'use client';

import { useState } from 'react';
import { ReceiptModal } from './ReceiptModal';

interface ReceiptIndicatorProps {
  transactionGuid: string;
  transactionDescription?: string;
  receiptCount: number;
}

export function ReceiptIndicator({ transactionGuid, transactionDescription, receiptCount }: ReceiptIndicatorProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setIsModalOpen(true)}
        className="p-1 rounded hover:bg-surface-hover transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
        aria-label={receiptCount > 0 ? `${receiptCount} receipt${receiptCount !== 1 ? 's' : ''} attached` : 'No receipts'}
        title={receiptCount > 0 ? `${receiptCount} receipt${receiptCount !== 1 ? 's' : ''}` : 'Attach receipt'}
      >
        {receiptCount > 0 ? (
          <svg className="w-4 h-4 text-primary" fill="currentColor" viewBox="0 0 24 24">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg className="w-4 h-4 text-foreground-secondary opacity-40" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <ReceiptModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        transactionGuid={transactionGuid}
        transactionDescription={transactionDescription}
      />
    </>
  );
}
