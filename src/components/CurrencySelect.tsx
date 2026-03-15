'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { CURRENCIES } from '@/lib/currencies';

interface CurrencySelectProps {
  value: string;
  onChange: (code: string) => void;
  id?: string;
  className?: string;
}

export function CurrencySelect({ value, onChange, id, className }: CurrencySelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    if (!search) return CURRENCIES;
    const q = search.toLowerCase();
    return CURRENCIES.filter(
      c => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
    );
  }, [search]);

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [filtered]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.children[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectedCurrency = CURRENCIES.find(c => c.code === value);
  const displayValue = selectedCurrency
    ? `${selectedCurrency.code} \u2014 ${selectedCurrency.name}`
    : value;

  const handleSelect = useCallback((code: string) => {
    onChange(code);
    setOpen(false);
    setSearch('');
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
        return;
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(i => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[highlightedIndex]) {
          handleSelect(filtered[highlightedIndex].code);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        setSearch('');
        break;
    }
  }, [open, filtered, highlightedIndex, handleSelect]);

  const listboxId = id ? `${id}-listbox` : 'currency-listbox';

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      {/* Trigger / display button */}
      {!open && (
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          onClick={() => {
            setOpen(true);
            // Focus input after state update
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="w-full bg-input-bg border border-input-border rounded-lg px-4 py-3 text-foreground text-left focus:outline-none focus:border-cyan-500/50 transition-colors"
        >
          {displayValue}
        </button>
      )}

      {/* Search input (shown when open) */}
      {open && (
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={true}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          aria-activedescendant={
            filtered[highlightedIndex]
              ? `currency-option-${filtered[highlightedIndex].code}`
              : undefined
          }
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search currencies..."
          className="w-full bg-input-bg border border-cyan-500/50 rounded-lg px-4 py-3 text-foreground focus:outline-none transition-colors"
        />
      )}

      {/* Dropdown list */}
      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="Currencies"
          className="absolute z-50 mt-1 w-full max-h-60 overflow-auto bg-surface border border-border rounded-lg shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-4 py-3 text-foreground-muted text-sm">No currencies found</li>
          ) : (
            filtered.map((c, i) => (
              <li
                key={c.code}
                id={`currency-option-${c.code}`}
                role="option"
                aria-selected={c.code === value}
                onClick={() => handleSelect(c.code)}
                onMouseEnter={() => setHighlightedIndex(i)}
                className={`px-4 py-2 cursor-pointer text-sm transition-colors ${
                  i === highlightedIndex
                    ? 'bg-cyan-500/10 text-foreground'
                    : c.code === value
                      ? 'text-cyan-400'
                      : 'text-foreground hover:bg-surface-hover'
                }`}
              >
                <span className="font-medium">{c.code}</span>
                <span className="text-foreground-muted"> &mdash; {c.name}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
