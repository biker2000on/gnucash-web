'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';

interface AutoAssignResult {
  lotsCreated: number;
  splitsAssigned: number;
  splitsCreated: number;
  gainsTransactions: number;
  totalRealizedGain: number;
  method: string;
  runId: string;
  warnings?: string[];
}

interface AutoAssignDialogProps {
  accountGuid: string;
  freeSplitsCount: number;
  currentMethod: string | null;
  isOpen: boolean;
  onClose: () => void;
  onAssign: (method: 'fifo' | 'lifo' | 'average') => Promise<AutoAssignResult | void>;
  onClearAll: () => Promise<void>;
}

const METHODS = [
  {
    value: 'fifo' as const,
    label: 'FIFO (First In, First Out)',
    description: 'Sells oldest shares first. Maximizes long-term capital gains treatment.',
  },
  {
    value: 'lifo' as const,
    label: 'LIFO (Last In, First Out)',
    description: 'Sells newest shares first. May minimize short-term gains.',
  },
  {
    value: 'average' as const,
    label: 'Average Cost',
    description: 'Each buy is a separate lot, but cost basis displays averaged across all open lots.',
  },
];

export default function AutoAssignDialog({
  accountGuid,
  freeSplitsCount,
  currentMethod,
  isOpen,
  onClose,
  onAssign,
  onClearAll,
}: AutoAssignDialogProps) {
  const [selectedMethod, setSelectedMethod] = useState<'fifo' | 'lifo' | 'average'>(
    (currentMethod as 'fifo' | 'lifo' | 'average') || 'fifo'
  );
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [result, setResult] = useState<AutoAssignResult | null>(null);
  const [revertLoading, setRevertLoading] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  if (!isOpen || typeof document === 'undefined') return null;

  const handleAssign = async () => {
    setLoading(true);
    setResult(null);
    setRevertError(null);
    try {
      const res = await onAssign(selectedMethod);
      if (res) {
        setResult(res);
      } else {
        onClose();
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    setLoading(true);
    try {
      await onClearAll();
      setConfirmClear(false);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  const handleRevert = async (runId: string) => {
    setRevertLoading(true);
    setRevertError(null);
    try {
      const res = await fetch(`/api/accounts/${accountGuid}/lots/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Revert failed');
      }
      setResult(null);
      onClose();
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : 'Revert failed');
    } finally {
      setRevertLoading(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4">
        <div className="p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-foreground">Auto-Assign Lots</h2>
            <button
              onClick={onClose}
              className="text-foreground-muted hover:text-foreground transition-colors"
            >
              &times;
            </button>
          </div>

          {result ? (
            /* Success summary view */
            <div className="space-y-3">
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-4">
                <p className="text-sm font-semibold text-emerald-400 mb-2">Assignment complete</p>
                <ul className="text-sm text-foreground-secondary space-y-1">
                  <li>{result.lotsCreated} lot{result.lotsCreated !== 1 ? 's' : ''} created</li>
                  <li>{result.splitsAssigned} split{result.splitsAssigned !== 1 ? 's' : ''} assigned</li>
                  {result.splitsCreated > 0 && (
                    <li>{result.splitsCreated} split{result.splitsCreated !== 1 ? 's' : ''} created</li>
                  )}
                </ul>

                {result.gainsTransactions > 0 && (
                  <div className="mt-2 text-sm">
                    <p>{result.gainsTransactions} capital gains transaction{result.gainsTransactions !== 1 ? 's' : ''} generated</p>
                    <p>Total realized: <span className={result.totalRealizedGain >= 0 ? 'text-green-600' : 'text-red-600'}>
                      ${Math.abs(result.totalRealizedGain).toFixed(2)} {result.totalRealizedGain >= 0 ? 'gain' : 'loss'}
                    </span></p>
                  </div>
                )}
              </div>

              {result.warnings && result.warnings.length > 0 && (
                <div className="mt-2 text-sm text-amber-600 space-y-1">
                  {result.warnings.map((w, i) => <p key={i}>&#9888; {w}</p>)}
                </div>
              )}

              {revertError && (
                <p className="text-xs text-rose-400">{revertError}</p>
              )}

              <div className="flex items-center justify-between pt-1">
                {result.runId && (
                  <button
                    onClick={() => handleRevert(result.runId)}
                    disabled={revertLoading}
                    className="text-xs text-gray-500 hover:text-red-600 underline disabled:opacity-50 transition-colors"
                  >
                    {revertLoading ? 'Undoing...' : 'Undo this assignment'}
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="ml-auto px-4 py-2 text-sm bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 transition-colors font-medium"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            /* Assignment configuration view */
            <>
              <div className="bg-background-secondary/30 rounded-lg p-3 text-sm">
                <span className="text-foreground-muted">Unassigned splits: </span>
                <span className="font-bold text-foreground">{freeSplitsCount}</span>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground-secondary">Assignment Method</label>
                {METHODS.map(method => (
                  <button
                    key={method.value}
                    onClick={() => setSelectedMethod(method.value)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedMethod === method.value
                        ? 'border-emerald-500/50 bg-emerald-500/5'
                        : 'border-border/50 hover:border-border'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-3 h-3 rounded-full border-2 ${
                        selectedMethod === method.value
                          ? 'border-emerald-500 bg-emerald-500'
                          : 'border-foreground-muted'
                      }`} />
                      <span className="text-sm font-medium text-foreground">{method.label}</span>
                    </div>
                    <p className="text-xs text-foreground-muted mt-1 ml-5">{method.description}</p>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-between pt-2">
                <div>
                  {confirmClear ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-rose-400">Are you sure?</span>
                      <button
                        onClick={handleClear}
                        disabled={loading}
                        className="px-3 py-1.5 text-xs bg-rose-500/20 text-rose-400 rounded hover:bg-rose-500/30 disabled:opacity-50 transition-colors"
                      >
                        Yes, Clear All
                      </button>
                      <button
                        onClick={() => setConfirmClear(false)}
                        className="px-3 py-1.5 text-xs text-foreground-muted hover:text-foreground transition-colors"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClear(true)}
                      className="px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 rounded transition-colors"
                    >
                      Clear All Assignments
                    </button>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-foreground-muted hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAssign}
                    disabled={loading || freeSplitsCount === 0}
                    className="px-4 py-2 text-sm bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 disabled:opacity-50 transition-colors font-medium"
                  >
                    {loading ? 'Assigning...' : `Assign ${freeSplitsCount} Splits`}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
