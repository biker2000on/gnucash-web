'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';

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
    const [data, setData] = useState<ValuationData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showPriceModal, setShowPriceModal] = useState(false);
    const [newPrice, setNewPrice] = useState({ date: '', value: '' });
    const [savingPrice, setSavingPrice] = useState(false);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch(`/api/accounts/${accountGuid}/valuation`);
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

    const { commodity, holdings, priceHistory, transactions } = data;

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

                {holdings?.latestPrice && (
                    <div className="mt-4 text-neutral-400">
                        Last price: {formatCurrency(holdings.latestPrice.value, 'USD')} on {holdings.latestPrice.date}
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
            {priceHistory && priceHistory.length > 0 && (
                <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-6">
                    <h3 className="text-lg font-semibold text-neutral-100 mb-4">Price History</h3>
                    <div className="h-48 flex items-end gap-1">
                        {/* Simple bar chart visualization */}
                        {(() => {
                            const minPrice = Math.min(...priceHistory.map(p => p.value));
                            const maxPrice = Math.max(...priceHistory.map(p => p.value));
                            const range = maxPrice - minPrice || 1;

                            return priceHistory.slice(-30).map((price, idx) => {
                                const height = ((price.value - minPrice) / range) * 100 + 10;
                                return (
                                    <div
                                        key={price.guid}
                                        className="flex-1 bg-cyan-500/60 hover:bg-cyan-500 rounded-t transition-colors cursor-pointer"
                                        style={{ height: `${height}%` }}
                                        title={`${price.date}: ${formatCurrency(price.value, 'USD')}`}
                                    />
                                );
                            });
                        })()}
                    </div>
                    <div className="flex justify-between mt-2 text-xs text-neutral-500">
                        <span>{priceHistory[0]?.date}</span>
                        <span>{priceHistory[priceHistory.length - 1]?.date}</span>
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
