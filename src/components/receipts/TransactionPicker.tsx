'use client';

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';

interface TransactionResult {
  guid: string;
  description: string;
  post_date: string;
  amount?: string;
}

interface TransactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (guid: string) => void;
}

export function TransactionPicker({ isOpen, onClose, onSelect }: TransactionPickerProps) {
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<TransactionResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchTransactions = useCallback(async (query: string) => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ search: query, limit: '20' });
      const res = await fetch(`/api/transactions?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setResults(data.transactions ?? []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTransactions(debouncedSearch);
  }, [debouncedSearch, fetchTransactions]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      setResults([]);
    }
  }, [isOpen]);

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Pick a Transaction" size="lg">
      <div className="p-4 space-y-3">
        <input
          type="search"
          placeholder="Search transactions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground placeholder-foreground-secondary focus:outline-none focus:border-primary"
        />

        {loading && (
          <div className="flex justify-center py-4">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
          </div>
        )}

        {!loading && results.length === 0 && debouncedSearch.trim() && (
          <p className="text-sm text-foreground-secondary text-center py-6">
            No transactions found for &ldquo;{debouncedSearch}&rdquo;.
          </p>
        )}

        {!loading && results.length === 0 && !debouncedSearch.trim() && (
          <p className="text-sm text-foreground-secondary text-center py-6">
            Start typing to search transactions.
          </p>
        )}

        {results.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
            {results.map((tx) => (
              <li key={tx.guid}>
                <button
                  onClick={() => {
                    onSelect(tx.guid);
                    onClose();
                  }}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-background hover:bg-surface-hover transition-colors min-h-[44px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">
                      {tx.description || '(no description)'}
                    </p>
                    <p className="text-xs text-foreground-secondary mt-0.5">
                      {formatDate(tx.post_date)}
                    </p>
                  </div>
                  {tx.amount && (
                    <span className="text-sm font-medium text-foreground shrink-0">
                      {tx.amount}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
