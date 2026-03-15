'use client';

import { useState, useRef, useEffect } from 'react';
import { useUserPreferences, type LedgerViewStyle } from '@/contexts/UserPreferencesContext';

interface ViewMenuProps {
  showSubaccounts: boolean;
  onToggleSubaccounts: () => void;
  showUnreviewedOnly: boolean;
  onToggleUnreviewed: () => void;
  hasSubaccounts: boolean;
}

const VIEW_MODES: { value: LedgerViewStyle; label: string; shortcut: string }[] = [
  { value: 'basic', label: 'Basic Ledger', shortcut: 'v b' },
  { value: 'journal', label: 'Transaction Journal', shortcut: 'v j' },
  { value: 'autosplit', label: 'Auto-Split', shortcut: 'v a' },
];

export default function ViewMenu({
  showSubaccounts,
  onToggleSubaccounts,
  showUnreviewedOnly,
  onToggleUnreviewed,
  hasSubaccounts,
}: ViewMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { ledgerViewStyle, setLedgerViewStyle } = useUserPreferences();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="px-3 py-2 min-h-[44px] text-xs rounded-lg border border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1"
      >
        View
        <span className="text-foreground-muted text-xs">&#9662;</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 z-50 mt-1 w-56 bg-surface border border-border rounded-lg shadow-xl overflow-hidden">
          {/* View Mode Section */}
          <div className="py-1 border-b border-border">
            <div className="px-3 py-1 text-xs text-foreground-muted uppercase tracking-wider">View Mode</div>
            {VIEW_MODES.map(mode => (
              <button
                key={mode.value}
                type="button"
                onClick={() => {
                  setLedgerViewStyle(mode.value);
                  setIsOpen(false);
                }}
                className="w-full px-3 py-2 text-sm text-left hover:bg-surface-hover flex justify-between items-center"
              >
                <span className={ledgerViewStyle === mode.value ? 'text-foreground' : 'text-foreground-secondary'}>
                  {ledgerViewStyle === mode.value ? '\u25CF' : '\u25CB'} {mode.label}
                </span>
                <span className="text-foreground-muted text-xs font-mono">{mode.shortcut}</span>
              </button>
            ))}
          </div>

          {/* Toggles Section */}
          <div className="py-1">
            {hasSubaccounts && (
              <button
                type="button"
                onClick={() => {
                  onToggleSubaccounts();
                  setIsOpen(false);
                }}
                className="w-full px-3 py-2 text-sm text-left text-foreground-secondary hover:bg-surface-hover flex items-center gap-2"
              >
                <span>{showSubaccounts ? '\u2611' : '\u2610'}</span>
                Sub-Accounts
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onToggleUnreviewed();
                setIsOpen(false);
              }}
              className="w-full px-3 py-2 text-sm text-left text-foreground-secondary hover:bg-surface-hover flex items-center gap-2"
            >
              <span>{showUnreviewedOnly ? '\u2611' : '\u2610'}</span>
              Unreviewed Only
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
