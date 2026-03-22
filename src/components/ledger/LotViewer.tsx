'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';
import AutoAssignDialog from './AutoAssignDialog';

interface LotSplit {
    guid: string;
    txGuid: string;
    postDate: string;
    description: string;
    shares: number;
    value: number;
    shareBalance: number;
}

interface LotSummary {
    guid: string;
    accountGuid: string;
    isClosed: boolean;
    title: string;
    openDate: string | null;
    closeDate: string | null;
    totalShares: number;
    totalCost: number;
    realizedGain: number;
    unrealizedGain: number | null;
    holdingPeriod: 'short_term' | 'long_term' | null;
    currentPrice: number | null;
    sourceLotGuid: string | null;
    acquisitionDate: string | null;
    splits: LotSplit[];
}

interface LotViewerProps {
    accountGuid: string;
    currencyMnemonic: string;
}

export default function LotViewer({ accountGuid, currencyMnemonic }: LotViewerProps) {
    const [lots, setLots] = useState<LotSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedLotGuid, setSelectedLotGuid] = useState<string | null>(null);
    const [showClosed, setShowClosed] = useState(false);
    const [freeSplits, setFreeSplits] = useState<LotSplit[]>([]);
    const [showAutoAssign, setShowAutoAssign] = useState(false);

    const fetchLots = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/accounts/${accountGuid}/lots?includeFreeSplits=true`);
            if (!res.ok) throw new Error('Failed to fetch lots');
            const data = await res.json();
            const lotList = Array.isArray(data) ? data : data.lots || [];
            setLots(lotList);
            setFreeSplits(data.freeSplits || []);
            // Auto-select first open lot
            const firstOpen = lotList.find((l: LotSummary) => !l.isClosed);
            if (firstOpen) setSelectedLotGuid(firstOpen.guid);
            else if (lotList.length > 0) setSelectedLotGuid(lotList[0].guid);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setLoading(false);
        }
    }, [accountGuid]);

    useEffect(() => { fetchLots(); }, [fetchLots]);

    const selectedLot = lots.find(l => l.guid === selectedLotGuid);
    const visibleLots = showClosed ? lots : lots.filter(l => !l.isClosed);
    const closedCount = lots.filter(l => l.isClosed).length;
    const openCount = lots.filter(l => !l.isClosed).length;

    // Summary stats
    const totalUnrealizedGain = lots
        .filter(l => !l.isClosed && l.unrealizedGain !== null)
        .reduce((sum, l) => sum + (l.unrealizedGain || 0), 0);
    const totalRealizedGain = lots
        .filter(l => l.isClosed)
        .reduce((sum, l) => sum + l.realizedGain, 0);
    const totalCost = lots
        .filter(l => !l.isClosed)
        .reduce((sum, l) => sum + l.totalCost, 0);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading lots...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="text-rose-400">{error}</div>
            </div>
        );
    }

    if (lots.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-foreground-muted">
                <div className="text-4xl mb-3">&#128230;</div>
                <h3 className="text-lg font-semibold mb-1">No Lots</h3>
                <p className="text-sm">
                    This account has no lot-tracked transactions. Lots are created when GnuCash assigns splits to lots for cost basis tracking.
                </p>
            </div>
        );
    }

    return (
        <>
        <div className="flex flex-col lg:flex-row gap-4">
            {/* Left: Lot List */}
            <div className="lg:w-1/3 space-y-3">
                {/* Summary Cards */}
                <div className="grid grid-cols-3 gap-2">
                    <div className="bg-background-secondary/30 rounded-lg p-2 text-center">
                        <div className="text-[10px] text-foreground-muted uppercase tracking-wider">Open</div>
                        <div className="text-sm font-bold text-foreground">{openCount}</div>
                    </div>
                    <div className="bg-background-secondary/30 rounded-lg p-2 text-center">
                        <div className="text-[10px] text-foreground-muted uppercase tracking-wider">Unrealized</div>
                        <div className={`text-sm font-bold font-mono ${totalUnrealizedGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {totalUnrealizedGain >= 0 ? '+' : ''}{formatCurrency(totalUnrealizedGain, currencyMnemonic)}
                        </div>
                    </div>
                    <div className="bg-background-secondary/30 rounded-lg p-2 text-center">
                        <div className="text-[10px] text-foreground-muted uppercase tracking-wider">Realized</div>
                        <div className={`text-sm font-bold font-mono ${totalRealizedGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {totalRealizedGain >= 0 ? '+' : ''}{formatCurrency(totalRealizedGain, currencyMnemonic)}
                        </div>
                    </div>
                </div>

                {/* Toggle closed lots */}
                {closedCount > 0 && (
                    <button
                        onClick={() => setShowClosed(!showClosed)}
                        className="text-xs text-foreground-muted hover:text-foreground transition-colors"
                    >
                        {showClosed ? 'Hide' : 'Show'} {closedCount} closed lot{closedCount !== 1 ? 's' : ''}
                    </button>
                )}

                {/* Unlinked splits */}
                {freeSplits.length > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium text-amber-400">
                        {freeSplits.length} unlinked split{freeSplits.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <button
                      onClick={() => setShowAutoAssign(true)}
                      className="text-xs px-2 py-1 bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 transition-colors"
                    >
                      Auto-Assign
                    </button>
                  </div>
                )}

                {/* Lot Cards */}
                <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
                    {visibleLots.map((lot, index) => {
                        const isSelected = lot.guid === selectedLotGuid;
                        const gainValue = lot.isClosed ? lot.realizedGain : lot.unrealizedGain;
                        const gainPercent = lot.totalCost !== 0 && gainValue !== null
                            ? ((gainValue / Math.abs(lot.totalCost)) * 100)
                            : null;

                        return (
                            <button
                                key={lot.guid}
                                onClick={() => setSelectedLotGuid(lot.guid)}
                                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                                    isSelected
                                        ? 'bg-surface border-emerald-500/30'
                                        : 'bg-background-secondary/20 border-border/50 hover:border-border hover:bg-background-secondary/40'
                                } ${lot.isClosed ? 'opacity-60' : ''}`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-sm font-medium text-foreground">
                                        {lot.title}
                                    </span>
                                    <div className="flex items-center gap-1.5">
                                        {lot.holdingPeriod && (
                                            <span className={`text-[9px] font-bold px-1 py-0.5 rounded ${
                                                lot.holdingPeriod === 'long_term'
                                                    ? 'bg-emerald-500/20 text-emerald-400'
                                                    : 'bg-amber-500/20 text-amber-400'
                                            }`}>
                                                {lot.holdingPeriod === 'long_term' ? 'LT' : 'ST'}
                                            </span>
                                        )}
                                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                            lot.isClosed
                                                ? 'bg-foreground-muted/10 text-foreground-muted'
                                                : 'bg-emerald-500/10 text-emerald-400'
                                        }`}>
                                            {lot.isClosed ? 'Closed' : 'Open'}
                                        </span>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                    <span className="text-foreground-muted font-mono">
                                        {lot.totalShares.toFixed(4)} shares
                                    </span>
                                    {gainValue !== null && (
                                        <span className={`font-mono ${gainValue >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {gainValue >= 0 ? '+' : ''}{formatCurrency(gainValue, currencyMnemonic)}
                                            {gainPercent !== null && (
                                                <span className="text-foreground-muted ml-1">
                                                    ({gainPercent >= 0 ? '+' : ''}{gainPercent.toFixed(1)}%)
                                                </span>
                                            )}
                                        </span>
                                    )}
                                </div>
                                {lot.openDate && (
                                    <div className="text-[10px] text-foreground-muted mt-0.5">
                                        Opened {new Date(lot.openDate).toLocaleDateString()}
                                        {lot.isClosed && lot.closeDate && (
                                            <span> &middot; Closed {new Date(lot.closeDate).toLocaleDateString()}</span>
                                        )}
                                    </div>
                                )}
                                {lot.sourceLotGuid && (
                                    <div className="mt-0.5">
                                        <span className="text-xs text-blue-400">
                                            &#8599; Transferred
                                            {lot.acquisitionDate && (
                                                <span className="text-foreground-muted"> (acquired {new Date(lot.acquisitionDate).toLocaleDateString()})</span>
                                            )}
                                        </span>
                                    </div>
                                )}
                                {lot.isClosed && lot.realizedGain !== 0 && (
                                    <div className="text-[10px] mt-0.5">
                                        <span className={lot.realizedGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                            {lot.realizedGain >= 0 ? 'Gain' : 'Loss'}: {formatCurrency(Math.abs(lot.realizedGain), currencyMnemonic)}
                                        </span>
                                        {lot.holdingPeriod && (
                                            <span className="text-foreground-muted ml-1">
                                                &middot; {lot.holdingPeriod === 'long_term' ? 'Long term' : 'Short term'}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Right: Lot Detail */}
            <div className="lg:w-2/3">
                {selectedLot ? (
                    <div className="space-y-4">
                        {/* Lot Header */}
                        <div className="flex items-start justify-between">
                            <div>
                                <h3 className="text-lg font-bold text-foreground">{selectedLot.title}</h3>
                                {selectedLot.openDate && (
                                    <p className="text-xs text-foreground-muted">
                                        Opened {new Date(selectedLot.openDate).toLocaleDateString()}
                                        {selectedLot.isClosed && selectedLot.closeDate && (
                                            <span> &middot; Closed {new Date(selectedLot.closeDate).toLocaleDateString()}</span>
                                        )}
                                    </p>
                                )}
                                {selectedLot.sourceLotGuid && (
                                    <p className="text-xs text-blue-400 mt-0.5">
                                        &#8599; Transferred
                                        {selectedLot.acquisitionDate && (
                                            <span className="text-foreground-muted"> &middot; acquired {new Date(selectedLot.acquisitionDate).toLocaleDateString()}</span>
                                        )}
                                    </p>
                                )}
                                {selectedLot.isClosed && selectedLot.realizedGain !== 0 && (
                                    <p className="text-xs mt-0.5">
                                        <span className={selectedLot.realizedGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                            Realized {selectedLot.realizedGain >= 0 ? 'gain' : 'loss'}: {formatCurrency(Math.abs(selectedLot.realizedGain), currencyMnemonic)}
                                        </span>
                                        {selectedLot.holdingPeriod && (
                                            <span className="text-foreground-muted ml-1">
                                                &middot; {selectedLot.holdingPeriod === 'long_term' ? 'Long term' : 'Short term'}
                                            </span>
                                        )}
                                    </p>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                {selectedLot.holdingPeriod && (
                                    <span className={`text-xs font-bold px-2 py-1 rounded ${
                                        selectedLot.holdingPeriod === 'long_term'
                                            ? 'bg-emerald-500/20 text-emerald-400'
                                            : 'bg-amber-500/20 text-amber-400'
                                    }`}>
                                        {selectedLot.holdingPeriod === 'long_term' ? 'Long Term' : 'Short Term'}
                                    </span>
                                )}
                                <span className={`text-xs font-bold px-2 py-1 rounded ${
                                    selectedLot.isClosed
                                        ? 'bg-foreground-muted/10 text-foreground-muted'
                                        : 'bg-emerald-500/10 text-emerald-400'
                                }`}>
                                    {selectedLot.isClosed ? 'Closed' : 'Open'}
                                </span>
                            </div>
                        </div>

                        {/* Lot Stats */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="bg-background-secondary/30 rounded-lg p-3">
                                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Shares</div>
                                <div className="text-sm font-bold font-mono text-foreground">{selectedLot.totalShares.toFixed(4)}</div>
                            </div>
                            <div className="bg-background-secondary/30 rounded-lg p-3">
                                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Cost Basis</div>
                                <div className="text-sm font-bold font-mono text-foreground">{formatCurrency(selectedLot.totalCost, currencyMnemonic)}</div>
                            </div>
                            {selectedLot.currentPrice !== null && (
                                <div className="bg-background-secondary/30 rounded-lg p-3">
                                    <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">Current Price</div>
                                    <div className="text-sm font-bold font-mono text-foreground">{formatCurrency(selectedLot.currentPrice, currencyMnemonic)}</div>
                                </div>
                            )}
                            <div className="bg-background-secondary/30 rounded-lg p-3">
                                <div className="text-[10px] text-foreground-muted uppercase tracking-wider mb-1">
                                    {selectedLot.isClosed ? 'Realized Gain' : 'Unrealized Gain'}
                                </div>
                                {(() => {
                                    const gain = selectedLot.isClosed ? selectedLot.realizedGain : selectedLot.unrealizedGain;
                                    if (gain === null) return <div className="text-sm font-mono text-foreground-muted">N/A</div>;
                                    return (
                                        <div className={`text-sm font-bold font-mono ${gain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {gain >= 0 ? '+' : ''}{formatCurrency(gain, currencyMnemonic)}
                                        </div>
                                    );
                                })()}
                            </div>
                        </div>

                        {/* Splits Table */}
                        <div>
                            <h4 className="text-sm font-semibold text-foreground-secondary mb-2 uppercase tracking-wider">
                                Splits in This Lot
                            </h4>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-xs text-foreground-muted uppercase tracking-wider border-b border-border">
                                            <th className="px-3 py-2 text-left">Date</th>
                                            <th className="px-3 py-2 text-left">Description</th>
                                            <th className="px-3 py-2 text-right">Shares</th>
                                            <th className="px-3 py-2 text-right">Value</th>
                                            <th className="px-3 py-2 text-right">Share Bal</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {selectedLot.splits.map(split => (
                                            <tr key={split.guid} className="border-b border-border/30 hover:bg-background-secondary/20 transition-colors">
                                                <td className="px-3 py-2 text-foreground-secondary whitespace-nowrap">
                                                    {new Date(split.postDate).toLocaleDateString()}
                                                </td>
                                                <td className="px-3 py-2 text-foreground">
                                                    {split.description}
                                                </td>
                                                <td className={`px-3 py-2 text-right font-mono ${split.shares > 0 ? 'text-emerald-400' : split.shares < 0 ? 'text-rose-400' : 'text-foreground-muted'}`}>
                                                    {split.shares > 0 ? '+' : ''}{split.shares.toFixed(4)}
                                                </td>
                                                <td className={`px-3 py-2 text-right font-mono ${split.value < 0 ? 'text-rose-400' : split.value > 0 ? 'text-emerald-400' : 'text-foreground-muted'}`}>
                                                    {formatCurrency(split.value, currencyMnemonic)}
                                                </td>
                                                <td className="px-3 py-2 text-right font-mono font-bold text-foreground">
                                                    {split.shareBalance.toFixed(4)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center justify-center py-12 text-foreground-muted">
                        <p>Select a lot to view details</p>
                    </div>
                )}
            </div>
        </div>

        {showAutoAssign && (
          <AutoAssignDialog
            accountGuid={accountGuid}
            freeSplitsCount={freeSplits.length}
            currentMethod={null}
            isOpen={showAutoAssign}
            onClose={() => setShowAutoAssign(false)}
            onAssign={async (method) => {
              const res = await fetch(`/api/accounts/${accountGuid}/lots/auto-assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method }),
              });
              fetchLots();
              if (res.ok) {
                return await res.json();
              }
            }}
            onClearAll={async () => {
              await fetch(`/api/accounts/${accountGuid}/lots/clear-assign`, {
                method: 'POST',
              });
              fetchLots();
            }}
          />
        )}
        </>
    );
}
