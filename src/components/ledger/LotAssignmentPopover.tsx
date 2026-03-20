'use client';

import { useState, useRef, useEffect } from 'react';

interface LotOption {
  guid: string;
  title: string;
  totalShares: number;
  isClosed: boolean;
}

interface LotAssignmentPopoverProps {
  splitGuid: string;
  currentLotGuid: string | null;
  accountGuid: string;
  lots: LotOption[];
  currencyMnemonic: string;
  onAssign: (splitGuid: string, lotGuid: string | null) => Promise<void>;
  onCreateAndAssign: (splitGuid: string, title: string) => Promise<void>;
}

export default function LotAssignmentPopover({
  splitGuid,
  currentLotGuid,
  accountGuid,
  lots,
  currencyMnemonic,
  onAssign,
  onCreateAndAssign,
}: LotAssignmentPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsCreating(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleAssign = async (lotGuid: string | null) => {
    setLoading(true);
    try {
      await onAssign(splitGuid, lotGuid);
      setIsOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setLoading(true);
    try {
      await onCreateAndAssign(splitGuid, newTitle.trim());
      setIsOpen(false);
      setIsCreating(false);
      setNewTitle('');
    } finally {
      setLoading(false);
    }
  };

  const currentLot = lots.find(l => l.guid === currentLotGuid);
  const openLots = lots.filter(l => !l.isClosed);

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
          currentLotGuid
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
            : 'border-border/50 bg-background-secondary/20 text-foreground-muted hover:bg-background-secondary/40'
        }`}
        title={currentLot ? `Assigned to: ${currentLot.title}` : 'Assign to lot'}
      >
        {currentLot ? currentLot.title : '+ Lot'}
      </button>

      {isOpen && (
        <div className="absolute z-50 top-full left-0 mt-1 w-56 bg-surface border border-border rounded-lg shadow-xl">
          <div className="p-2 space-y-1">
            <div className="text-[10px] text-foreground-muted uppercase tracking-wider px-2 py-1">
              Assign to Lot
            </div>

            {currentLotGuid && (
              <button
                onClick={() => handleAssign(null)}
                disabled={loading}
                className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-background-secondary/40 text-rose-400 transition-colors"
              >
                Unassign
              </button>
            )}

            {openLots.map(lot => (
              <button
                key={lot.guid}
                onClick={() => handleAssign(lot.guid)}
                disabled={loading || lot.guid === currentLotGuid}
                className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors ${
                  lot.guid === currentLotGuid
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'hover:bg-background-secondary/40 text-foreground'
                }`}
              >
                <span className="font-medium">{lot.title}</span>
                <span className="text-foreground-muted ml-1">
                  ({lot.totalShares.toFixed(2)} shares)
                </span>
              </button>
            ))}

            <div className="border-t border-border/50 my-1" />

            {isCreating ? (
              <div className="px-2 py-1 space-y-1">
                <input
                  type="text"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
                  placeholder="Lot title..."
                  className="w-full px-2 py-1 text-xs bg-input-bg border border-border rounded text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') { setIsCreating(false); setNewTitle(''); }
                  }}
                />
                <div className="flex gap-1">
                  <button
                    onClick={handleCreate}
                    disabled={loading || !newTitle.trim()}
                    className="flex-1 px-2 py-1 text-xs bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30 disabled:opacity-50 transition-colors"
                  >
                    Create
                  </button>
                  <button
                    onClick={() => { setIsCreating(false); setNewTitle(''); }}
                    className="px-2 py-1 text-xs text-foreground-muted hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setIsCreating(true)}
                className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-background-secondary/40 text-cyan-400 transition-colors"
              >
                + New Lot
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
