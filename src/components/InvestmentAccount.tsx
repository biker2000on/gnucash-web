'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/contexts/ToastContext';
import { InvestmentTransactionForm } from './InvestmentTransactionForm';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea } from 'recharts';
import type { CategoricalChartFunc } from 'recharts/types/chart/types';

interface PriceData {
    guid: string;
    date: string;
    value: number;
    source: string | null;
}

interface TransactionData {
    guid: string;
    date: string;
    description: string;
    shares: number;
    amount: number;
    action: string;
}

interface ValuationData {
    isInvestment: boolean;
    account: {
        guid: string;
        name: string;
        account_type: string;
    };
    commodity?: {
        guid: string;
        namespace: string;
        mnemonic: string;
        fullname: string | null;
    };
    holdings?: {
        shares: number;
        costBasis: number;
        marketValue: number;
        gainLoss: number;
        gainLossPercent: number;
        latestPrice: PriceData | null;
    };
    priceHistory?: PriceData[];
    transactions?: TransactionData[];
}

interface InvestmentAccountProps {
    accountGuid: string;
}

export function InvestmentAccount({ accountGuid }: InvestmentAccountProps) {
    const router = useRouter();
    const { success, error: showError } = useToast();
    const [data, setData] = useState<ValuationData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showPriceModal, setShowPriceModal] = useState(false);
    const [newPrice, setNewPrice] = useState({ date: '', value: '' });
    const [savingPrice, setSavingPrice] = useState(false);
    const [fetchingPrice, setFetchingPrice] = useState(false);
    const [showTransactionModal, setShowTransactionModal] = useState(false);

    // Time period selection
    const [selectedPeriod, setSelectedPeriod] = useState<'1M' | '3M' | '6M' | '1Y' | 'ALL'>('3M');

    // Index-based zoom state
    interface ZoomDomain {
        startIndex: number | null;
        endIndex: number | null;
    }
    const [zoomDomain, setZoomDomain] = useState<ZoomDomain>({ startIndex: null, endIndex: null });

    // Drag selection state
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState<number | null>(null);
    const [dragEnd, setDragEnd] = useState<number | null>(null);

    // Chart container ref for wheel events
    const chartContainerRef = useRef<HTMLDivElement>(null);

    // 1. Memoize filtered price history based on period selection
    const filteredPriceHistory = useMemo(() => {
        if (!data?.priceHistory) return [];
        const priceHistory = data.priceHistory;
        const now = new Date();
        const cutoffDate = new Date();

        switch (selectedPeriod) {
            case '1M':
                cutoffDate.setMonth(now.getMonth() - 1);
                break;
            case '3M':
                cutoffDate.setMonth(now.getMonth() - 3);
                break;
            case '6M':
                cutoffDate.setMonth(now.getMonth() - 6);
                break;
            case '1Y':
                cutoffDate.setFullYear(now.getFullYear() - 1);
                break;
            case 'ALL':
                return priceHistory;
        }
        return priceHistory.filter(p => new Date(p.date) >= cutoffDate);
    }, [data?.priceHistory, selectedPeriod]);

    // 2. Memoize chart data (applies zoom to filtered data)
    const chartData = useMemo(() => {
        if (!filteredPriceHistory.length) return [];

        // No zoom applied - return all filtered data
        if (zoomDomain.startIndex === null && zoomDomain.endIndex === null) {
            return filteredPriceHistory;
        }

        const start = zoomDomain.startIndex ?? 0;
        const end = zoomDomain.endIndex ?? filteredPriceHistory.length;
        return filteredPriceHistory.slice(start, end + 1);
    }, [filteredPriceHistory, zoomDomain.startIndex, zoomDomain.endIndex]);

    // Mouse down handler - start drag selection
    const handleMouseDown = useCallback<CategoricalChartFunc>((nextState) => {
        if (nextState.activeTooltipIndex !== undefined) {
            setIsDragging(true);
            setDragStart(nextState.activeTooltipIndex as number);
            setDragEnd(nextState.activeTooltipIndex as number);
        }
    }, []);

    // Mouse move handler - update drag selection
    const handleMouseMove = useCallback<CategoricalChartFunc>((nextState) => {
        if (isDragging && nextState.activeTooltipIndex !== undefined) {
            setDragEnd(nextState.activeTooltipIndex as number);
        }
    }, [isDragging]);

    // Mouse up handler - apply zoom
    const handleMouseUp = useCallback(() => {
        if (isDragging && dragStart !== null && dragEnd !== null && dragStart !== dragEnd) {
            const startIdx = Math.min(dragStart, dragEnd);
            const endIdx = Math.max(dragStart, dragEnd);
            setZoomDomain({ startIndex: startIdx, endIndex: endIdx });
        }
        setIsDragging(false);
        setDragStart(null);
        setDragEnd(null);
    }, [isDragging, dragStart, dragEnd]);

    // Wheel zoom handler - depends on filteredPriceHistory.length only
    const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
        e.preventDefault();
        const dataLength = filteredPriceHistory.length;
        if (dataLength < 2) return;

        // Get current visible range
        const currentStart = zoomDomain.startIndex ?? 0;
        const currentEnd = zoomDomain.endIndex ?? dataLength - 1;
        const currentLength = currentEnd - currentStart + 1;

        // Calculate zoom factor (scroll up = zoom in, scroll down = zoom out)
        const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;
        const newLength = Math.max(5, Math.min(dataLength, Math.round(currentLength * zoomFactor)));

        // If zooming out to full range, reset zoom
        if (newLength >= dataLength) {
            setZoomDomain({ startIndex: null, endIndex: null });
            return;
        }

        // Calculate center and new range
        const center = Math.floor((currentStart + currentEnd) / 2);
        const halfNew = Math.floor(newLength / 2);
        const newStart = Math.max(0, Math.min(dataLength - newLength, center - halfNew));
        const newEnd = Math.min(dataLength - 1, newStart + newLength - 1);

        setZoomDomain({ startIndex: newStart, endIndex: newEnd });
    }, [filteredPriceHistory.length, zoomDomain.startIndex, zoomDomain.endIndex]);

    // Reset zoom handler
    const handleZoomReset = useCallback(() => {
        setZoomDomain({ startIndex: null, endIndex: null });
    }, []);

    // Period change handler - resets zoom
    const handlePeriodChange = useCallback((period: '1M' | '3M' | '6M' | '1Y' | 'ALL') => {
        setSelectedPeriod(period);
        setZoomDomain({ startIndex: null, endIndex: null });
    }, []);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch(`/api/accounts/${accountGuid}/valuation?days=365`);
            if (!res.ok) throw new Error('Failed to fetch valuation');
            const json = await res.json();
            setData(json);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An error occurred');
        } finally {
            setLoading(false);
        }
    }, [accountGuid]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    // Reset zoom when period changes
    useEffect(() => {
        setZoomDomain({ startIndex: null, endIndex: null });
    }, [selectedPeriod]);

    const handleFetchPrice = async () => {
        if (!data?.commodity) return;

        setFetchingPrice(true);
        try {
            const response = await fetch('/api/prices/fetch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbols: [data.commodity.mnemonic] }),
            });

            const responseData = await response.json();

            if (!response.ok) {
                showError(responseData.error || 'Failed to fetch price');
                return;
            }

            if (responseData.stored > 0) {
                success(`Price updated: $${responseData.results[0]?.price?.toFixed(2)}`);
                router.refresh();
            } else {
                showError(responseData.results[0]?.error || 'Failed to fetch price');
            }
        } catch (err) {
            showError('Network error fetching price');
        } finally {
            setFetchingPrice(false);
        }
    };

    const handleAddPrice = async () => {
        if (!data?.commodity || !newPrice.date || !newPrice.value) return;

        setSavingPrice(true);
        try {
            // Find USD currency for pricing
            const commoditiesRes = await fetch('/api/commodities');
            const commodities = await commoditiesRes.json();
            const usd = commodities.find((c: { mnemonic: string; namespace: string }) =>
                c.mnemonic === 'USD' && c.namespace === 'CURRENCY'
            );

            if (!usd) {
                throw new Error('USD currency not found');
            }

            const res = await fetch('/api/prices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    commodity_guid: data.commodity.guid,
                    currency_guid: usd.guid,
                    date: newPrice.date,
                    value: parseFloat(newPrice.value),
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to add price');
            }

            setShowPriceModal(false);
            setNewPrice({ date: '', value: '' });
            fetchData();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to add price');
        } finally {
            setSavingPrice(false);
        }
    };

    if (loading) {
        return (
            <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-8 flex items-center justify-center">
                <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                    <span className="text-neutral-400">Loading investment data...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-neutral-900/30 backdrop-blur-xl border border-rose-800/50 rounded-2xl p-8 text-center">
                <div className="text-rose-400">{error}</div>
            </div>
        );
    }

    if (!data || !data.isInvestment) {
        return null; // Not an investment account
    }

    const { commodity, holdings, transactions } = data;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-6">
                <div className="flex items-start justify-between">
                    <div>
                        <div className="flex items-center gap-3">
                            <h2 className="text-2xl font-bold text-neutral-100">
                                {commodity?.mnemonic || 'Unknown'}
                            </h2>
                            {commodity?.namespace && (
                                <span className="px-2 py-1 text-xs bg-cyan-500/20 text-cyan-400 rounded-lg">
                                    {commodity.namespace}
                                </span>
                            )}
                        </div>
                        {commodity?.fullname && (
                            <p className="text-neutral-500 mt-1">{commodity.fullname}</p>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowTransactionModal(true)}
                            className="flex items-center gap-2 px-3 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            New Transaction
                        </button>
                        <button
                            onClick={handleFetchPrice}
                            disabled={fetchingPrice}
                            className="flex items-center gap-2 px-3 py-2 text-sm bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors disabled:opacity-50"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            {fetchingPrice ? 'Fetching...' : 'Fetch Price'}
                        </button>
                        <button
                            onClick={() => {
                                setNewPrice({ date: new Date().toISOString().split('T')[0], value: '' });
                                setShowPriceModal(true);
                            }}
                            className="flex items-center gap-2 px-3 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            Add Price
                        </button>
                    </div>
                </div>

                {holdings?.latestPrice && (
                    <div className="mt-4 text-neutral-400">
                        Last price: {formatCurrency(holdings.latestPrice.value, 'USD')} on{' '}
                        {new Date(holdings.latestPrice.date).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                        })}
                    </div>
                )}
            </div>

            {/* Holdings Summary */}
            {holdings && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-4">
                        <div className="text-xs text-neutral-500 uppercase tracking-wider">Shares</div>
                        <div className="text-xl font-mono font-semibold text-neutral-100 mt-1">
                            {holdings.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </div>
                    </div>
                    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-4">
                        <div className="text-xs text-neutral-500 uppercase tracking-wider">Cost Basis</div>
                        <div className="text-xl font-mono font-semibold text-neutral-100 mt-1">
                            {formatCurrency(Math.abs(holdings.costBasis), 'USD')}
                        </div>
                    </div>
                    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-4">
                        <div className="text-xs text-neutral-500 uppercase tracking-wider">Market Value</div>
                        <div className="text-xl font-mono font-semibold text-neutral-100 mt-1">
                            {formatCurrency(holdings.marketValue, 'USD')}
                        </div>
                    </div>
                    <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-4">
                        <div className="text-xs text-neutral-500 uppercase tracking-wider">Gain/Loss</div>
                        <div className={`text-xl font-mono font-semibold mt-1 ${
                            holdings.gainLoss >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}>
                            {holdings.gainLoss >= 0 ? '+' : ''}{formatCurrency(holdings.gainLoss, 'USD')}
                            <span className="text-sm ml-2">
                                ({holdings.gainLoss >= 0 ? '+' : ''}{holdings.gainLossPercent.toFixed(2)}%)
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* Price History Chart */}
            {data?.priceHistory && data.priceHistory.length > 0 && (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-6">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-lg font-semibold text-neutral-100">Price History</h3>
                        <div className="flex items-center gap-2">
                            <div className="flex gap-1">
                                {(['1M', '3M', '6M', '1Y', 'ALL'] as const).map(period => (
                                    <button
                                        key={period}
                                        onClick={() => handlePeriodChange(period)}
                                        className={`px-3 py-1 text-sm rounded-lg transition-colors ${
                                            selectedPeriod === period
                                                ? 'bg-cyan-600 text-white'
                                                : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200'
                                        }`}
                                    >
                                        {period}
                                    </button>
                                ))}
                            </div>
                            {(zoomDomain.startIndex !== null || zoomDomain.endIndex !== null) && (
                                <button
                                    onClick={handleZoomReset}
                                    className="px-3 py-1 text-sm bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200 rounded-lg transition-colors flex items-center gap-1"
                                >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                    Reset
                                </button>
                            )}
                        </div>
                    </div>
                    <div
                        ref={chartContainerRef}
                        className="h-64"
                        onWheel={handleWheel}
                    >
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart
                                data={chartData}
                                onMouseDown={handleMouseDown}
                                onMouseMove={handleMouseMove}
                                onMouseUp={handleMouseUp}
                                onMouseLeave={handleMouseUp}
                            >
                                <XAxis
                                    dataKey="date"
                                    tick={{ fill: '#737373', fontSize: 12 }}
                                    tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                    stroke="#404040"
                                />
                                <YAxis
                                    tick={{ fill: '#737373', fontSize: 12 }}
                                    tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
                                    stroke="#404040"
                                    domain={['auto', 'auto']}
                                    width={70}
                                />
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: '#171717',
                                        border: '1px solid #404040',
                                        borderRadius: '8px'
                                    }}
                                    labelStyle={{ color: '#a3a3a3' }}
                                    formatter={(value: number | undefined) => [`$${Number(value).toFixed(2)}`, 'Price']}
                                    labelFormatter={(date) => new Date(date).toLocaleDateString('en-US', {
                                        weekday: 'short',
                                        month: 'short',
                                        day: 'numeric',
                                        year: 'numeric'
                                    })}
                                />
                                <Line
                                    type="monotone"
                                    dataKey="value"
                                    stroke="#06b6d4"
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 4, fill: '#06b6d4' }}
                                    animationDuration={300}
                                />
                                {isDragging && dragStart !== null && dragEnd !== null && (
                                    <ReferenceArea
                                        x1={chartData[Math.min(dragStart, dragEnd)]?.date}
                                        x2={chartData[Math.max(dragStart, dragEnd)]?.date}
                                        strokeOpacity={0.3}
                                        fill="#06b6d4"
                                        fillOpacity={0.3}
                                    />
                                )}
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            )}

            {/* Transaction History */}
            {transactions && transactions.length > 0 && (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl overflow-hidden">
                    <div className="p-4 border-b border-neutral-800">
                        <h3 className="text-lg font-semibold text-neutral-100">Transaction History</h3>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-neutral-800 text-neutral-400 text-sm uppercase tracking-wider">
                                    <th className="py-3 px-4 text-left font-medium">Date</th>
                                    <th className="py-3 px-4 text-left font-medium">Description</th>
                                    <th className="py-3 px-4 text-left font-medium">Action</th>
                                    <th className="py-3 px-4 text-right font-medium">Shares</th>
                                    <th className="py-3 px-4 text-right font-medium">Amount</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-800/50">
                                {transactions.map(tx => (
                                    <tr key={tx.guid} className="hover:bg-neutral-800/20 transition-colors">
                                        <td className="py-2 px-4 text-neutral-300 font-mono text-sm">
                                            {tx.date}
                                        </td>
                                        <td className="py-2 px-4 text-neutral-200">
                                            {tx.description}
                                        </td>
                                        <td className="py-2 px-4 text-neutral-400 text-sm">
                                            {tx.action || '-'}
                                        </td>
                                        <td className="py-2 px-4 text-right font-mono">
                                            <span className={tx.shares >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                                {tx.shares >= 0 ? '+' : ''}{tx.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                                            </span>
                                        </td>
                                        <td className="py-2 px-4 text-right font-mono">
                                            <span className={tx.amount >= 0 ? 'text-rose-400' : 'text-emerald-400'}>
                                                {formatCurrency(Math.abs(tx.amount), 'USD')}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Investment Transaction Modal */}
            {showTransactionModal && commodity && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                        <InvestmentTransactionForm
                            accountGuid={data.account.guid}
                            accountName={data.account.name}
                            accountCommodityGuid={commodity.guid}
                            commoditySymbol={commodity.mnemonic}
                            onSave={() => {
                                setShowTransactionModal(false);
                                fetchData();
                            }}
                            onCancel={() => setShowTransactionModal(false)}
                        />
                    </div>
                </div>
            )}

            {/* Add Price Modal */}
            {showPriceModal && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md mx-4">
                        <h3 className="text-lg font-semibold text-neutral-100 mb-4">Add Price</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                                    Date
                                </label>
                                <input
                                    type="date"
                                    value={newPrice.date}
                                    onChange={e => setNewPrice(prev => ({ ...prev, date: e.target.value }))}
                                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                                />
                            </div>
                            <div>
                                <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                                    Price (USD)
                                </label>
                                <input
                                    type="number"
                                    step="0.01"
                                    value={newPrice.value}
                                    onChange={e => setNewPrice(prev => ({ ...prev, value: e.target.value }))}
                                    placeholder="0.00"
                                    className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                                />
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button
                                onClick={() => setShowPriceModal(false)}
                                className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleAddPrice}
                                disabled={savingPrice || !newPrice.date || !newPrice.value}
                                className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-lg transition-colors"
                            >
                                {savingPrice ? 'Saving...' : 'Add Price'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
