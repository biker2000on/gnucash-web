'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { TransactionSuggestion } from '@/app/api/transactions/descriptions/route';

interface DescriptionAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelectSuggestion?: (suggestion: TransactionSuggestion) => void;
  placeholder?: string;
  className?: string;
  hasError?: boolean;
  accountGuid?: string;
}

export function DescriptionAutocomplete({
  value,
  onChange,
  onSelectSuggestion,
  placeholder = 'Enter description...',
  className = '',
  hasError = false,
  accountGuid,
}: DescriptionAutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<TransactionSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isFocusedRef = useRef(false);

  // Debounced API call
  useEffect(() => {
    if (value.length < 2) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    // Clear existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Set new timer
    debounceTimerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q: value,
          limit: '10'
        });
        if (accountGuid) {
          params.append('account_guid', accountGuid);
        }
        const response = await fetch(`/api/transactions/descriptions?${params.toString()}`);
        const data = await response.json();
        setSuggestions(data.suggestions || []);
        if (data.suggestions && data.suggestions.length > 0 && isFocusedRef.current) {
          setIsOpen(true);
          setFocusedIndex(0);
        } else {
          setIsOpen(false);
        }
      } catch (error) {
        console.error('Error fetching suggestions:', error);
        setSuggestions([]);
        setIsOpen(false);
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [value, accountGuid]);

  // Calculate dropdown position when opening
  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        zIndex: 99999,
      });
    }
  }, [isOpen]);

  // Close dropdown when clicking outside (accounts for portal)
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInsideContainer = containerRef.current?.contains(target);
      const isInsideDropdown = (target as HTMLElement).closest?.('[data-description-dropdown]');

      if (!isInsideContainer && !isInsideDropdown) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex !== null && itemRefs.current[focusedIndex]) {
      itemRefs.current[focusedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      });
    }
  }, [focusedIndex]);

  const handleSelect = (suggestion: TransactionSuggestion) => {
    onChange(suggestion.description);
    setIsOpen(false);
    setFocusedIndex(null);
    if (onSelectSuggestion) {
      onSelectSuggestion(suggestion);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' && suggestions.length > 0) {
        setIsOpen(true);
        setFocusedIndex(0);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        setFocusedIndex(prev =>
          prev === null ? 0 : Math.min(prev + 1, suggestions.length - 1)
        );
        e.preventDefault();
        break;
      case 'ArrowUp':
        setFocusedIndex(prev =>
          prev === null ? suggestions.length - 1 : Math.max(prev - 1, 0)
        );
        e.preventDefault();
        break;
      case 'Enter':
        if (focusedIndex !== null && suggestions[focusedIndex]) {
          handleSelect(suggestions[focusedIndex]);
          e.preventDefault();
        }
        break;
      case 'Tab':
        if (focusedIndex !== null && suggestions[focusedIndex]) {
          handleSelect(suggestions[focusedIndex]);
          e.preventDefault();
        }
        break;
      case 'Escape':
        setIsOpen(false);
        setFocusedIndex(null);
        e.preventDefault();
        break;
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          isFocusedRef.current = true;
          if (suggestions.length > 0) setIsOpen(true);
        }}
        onBlur={() => {
          isFocusedRef.current = false;
          setTimeout(() => {
            if (!isFocusedRef.current) setIsOpen(false);
          }, 200);
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        data-field="description"
        className={`w-full bg-input-bg border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none ${
          isOpen ? 'border-cyan-500/50 ring-1 ring-cyan-500/20' : hasError ? 'border-rose-500 ring-1 ring-rose-500/30' : 'border-border focus:border-cyan-500/50'
        }`}
      />

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          data-description-dropdown
          style={dropdownStyle}
          className="bg-background-secondary border border-border rounded-lg shadow-xl max-h-64 overflow-y-auto"
        >
          {loading ? (
            <div className="px-3 py-4 text-center text-foreground-muted text-sm">
              <div className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-foreground-muted border-t-cyan-500 rounded-full animate-spin" />
                Loading suggestions...
              </div>
            </div>
          ) : suggestions.length === 0 ? (
            <div className="px-3 py-4 text-center text-foreground-muted text-sm">
              No suggestions found
            </div>
          ) : (
            suggestions.map((suggestion, index) => (
              <div
                key={index}
                ref={el => { itemRefs.current[index] = el; }}
                className={`px-3 py-2 cursor-pointer hover:bg-surface-hover/50 ${
                  index === focusedIndex ? 'bg-blue-100 dark:bg-blue-900' : ''
                }`}
                onClick={() => handleSelect(suggestion)}
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm text-foreground">{suggestion.description}</div>
                  <div className="text-xs text-foreground-muted">{formatDate(suggestion.lastUsed)}</div>
                </div>
                {suggestion.splits.length === 2 && (
                  <div className="text-xs text-foreground-muted mt-1">
                    {Math.abs(suggestion.splits[0].amount).toFixed(2)} · {suggestion.splits[0].accountName} → {suggestion.splits[1].accountName}
                  </div>
                )}
              </div>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
