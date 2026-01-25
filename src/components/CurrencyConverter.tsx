'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '@/lib/format';

interface Currency {
    guid: string;
    mnemonic: string;
    fullname: string | null;
}

interface ConversionResult {
    convertedAmount: number;
    rate: number;
    rateDate: string;
    source: string | null;
}

interface CurrencyConverterProps {
    defaultFromCurrency?: string;
    defaultToCurrency?: string;
    defaultAmount?: number;
}

export function CurrencyConverter({
    defaultFromCurrency = 'USD',
    defaultToCurrency = 'EUR',
    defaultAmount = 100,
}: CurrencyConverterProps) {
    const [currencies, setCurrencies] = useState<Currency[]>([]);
    const [fromCurrency, setFromCurrency] = useState(defaultFromCurrency);
    const [toCurrency, setToCurrency] = useState(defaultToCurrency);
    const [amount, setAmount] = useState(defaultAmount.toString());
    const [result, setResult] = useState<ConversionResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Fetch available currencies
    useEffect(() => {
        async function fetchCurrencies() {
            try {
                const res = await fetch('/api/commodities?namespace=CURRENCY');
                if (!res.ok) throw new Error('Failed to fetch currencies');
                const data = await res.json();
                setCurrencies(data);
            } catch (err) {
                console.error('Error fetching currencies:', err);
            }
        }
        fetchCurrencies();
    }, []);

    // Perform conversion
    const convert = useCallback(async () => {
        if (!amount || parseFloat(amount) <= 0) {
            setResult(null);
            return;
        }

        const fromCurrencyObj = currencies.find(c => c.mnemonic === fromCurrency);
        const toCurrencyObj = currencies.find(c => c.mnemonic === toCurrency);

        if (!fromCurrencyObj || !toCurrencyObj) {
            setResult(null);
            return;
        }

        setLoading(true);
        setError(null);

        try {
            // Use the prices API to find the exchange rate
            const res = await fetch(`/api/prices?commodity_guid=${fromCurrencyObj.guid}&currency_guid=${toCurrencyObj.guid}&limit=1`);

            if (!res.ok) throw new Error('Failed to fetch exchange rate');
            const data = await res.json();

            if (data.prices && data.prices.length > 0) {
                const rate = data.prices[0].value;
                setResult({
                    convertedAmount: parseFloat(amount) * rate,
                    rate,
                    rateDate: data.prices[0].date,
                    source: data.prices[0].source,
                });
            } else {
                // Try inverse
                const inverseRes = await fetch(`/api/prices?commodity_guid=${toCurrencyObj.guid}&currency_guid=${fromCurrencyObj.guid}&limit=1`);

                if (inverseRes.ok) {
                    const inverseData = await inverseRes.json();
                    if (inverseData.prices && inverseData.prices.length > 0) {
                        const inverseRate = inverseData.prices[0].value;
                        const rate = 1 / inverseRate;
                        setResult({
                            convertedAmount: parseFloat(amount) * rate,
                            rate,
                            rateDate: inverseData.prices[0].date,
                            source: `inverse:${inverseData.prices[0].source}`,
                        });
                    } else {
                        setError('No exchange rate found for this currency pair');
                        setResult(null);
                    }
                } else {
                    setError('No exchange rate found for this currency pair');
                    setResult(null);
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Conversion failed');
            setResult(null);
        } finally {
            setLoading(false);
        }
    }, [amount, fromCurrency, toCurrency, currencies]);

    // Debounced conversion
    useEffect(() => {
        const timer = setTimeout(convert, 300);
        return () => clearTimeout(timer);
    }, [convert]);

    const swapCurrencies = () => {
        setFromCurrency(toCurrency);
        setToCurrency(fromCurrency);
    };

    return (
        <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-xl p-6">
            <h3 className="text-lg font-semibold text-neutral-100 mb-4">Currency Converter</h3>

            <div className="space-y-4">
                {/* Amount Input */}
                <div>
                    <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                        Amount
                    </label>
                    <input
                        type="number"
                        value={amount}
                        onChange={e => setAmount(e.target.value)}
                        placeholder="Enter amount"
                        className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-4 py-3 text-lg font-mono text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                    />
                </div>

                {/* Currency Selectors */}
                <div className="flex items-center gap-2">
                    <div className="flex-1">
                        <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                            From
                        </label>
                        <select
                            value={fromCurrency}
                            onChange={e => setFromCurrency(e.target.value)}
                            className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                        >
                            {currencies.map(c => (
                                <option key={c.guid} value={c.mnemonic}>
                                    {c.mnemonic} - {c.fullname || c.mnemonic}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Swap Button */}
                    <button
                        onClick={swapCurrencies}
                        className="mt-5 p-2 text-neutral-400 hover:text-cyan-400 transition-colors"
                        title="Swap currencies"
                    >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                        </svg>
                    </button>

                    <div className="flex-1">
                        <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                            To
                        </label>
                        <select
                            value={toCurrency}
                            onChange={e => setToCurrency(e.target.value)}
                            className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                        >
                            {currencies.map(c => (
                                <option key={c.guid} value={c.mnemonic}>
                                    {c.mnemonic} - {c.fullname || c.mnemonic}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Result */}
                {loading ? (
                    <div className="flex items-center justify-center py-4">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                    </div>
                ) : error ? (
                    <div className="py-4 text-center text-rose-400 text-sm">{error}</div>
                ) : result ? (
                    <div className="bg-neutral-800/50 rounded-lg p-4">
                        <div className="text-center">
                            <div className="text-2xl font-mono font-bold text-cyan-400">
                                {result.convertedAmount.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 4,
                                })} {toCurrency}
                            </div>
                            <div className="text-sm text-neutral-400 mt-2">
                                1 {fromCurrency} = {result.rate.toLocaleString(undefined, {
                                    minimumFractionDigits: 4,
                                    maximumFractionDigits: 6,
                                })} {toCurrency}
                            </div>
                            <div className="text-xs text-neutral-500 mt-1">
                                Rate from {result.rateDate}
                                {result.source && ` (${result.source})`}
                            </div>
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

// Currency Selector Component
export function CurrencySelector({
    value,
    onChange,
    label,
}: {
    value: string;
    onChange: (value: string) => void;
    label?: string;
}) {
    const [currencies, setCurrencies] = useState<Currency[]>([]);
    const [search, setSearch] = useState('');
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        async function fetchCurrencies() {
            try {
                const res = await fetch('/api/commodities?namespace=CURRENCY');
                if (!res.ok) throw new Error('Failed to fetch currencies');
                const data = await res.json();
                setCurrencies(data);
            } catch (err) {
                console.error('Error fetching currencies:', err);
            }
        }
        fetchCurrencies();
    }, []);

    const filteredCurrencies = currencies.filter(c =>
        c.mnemonic.toLowerCase().includes(search.toLowerCase()) ||
        c.fullname?.toLowerCase().includes(search.toLowerCase())
    );

    const selectedCurrency = currencies.find(c => c.mnemonic === value);

    return (
        <div className="relative">
            {label && (
                <label className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">
                    {label}
                </label>
            )}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full bg-neutral-950/50 border border-neutral-800 rounded-lg px-3 py-2 text-left text-neutral-200 focus:outline-none focus:border-cyan-500/50 flex items-center justify-between"
            >
                <span>{selectedCurrency ? `${selectedCurrency.mnemonic} - ${selectedCurrency.fullname || selectedCurrency.mnemonic}` : 'Select currency'}</span>
                <svg className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {isOpen && (
                <div className="absolute z-10 w-full mt-1 bg-neutral-900 border border-neutral-800 rounded-lg shadow-lg max-h-60 overflow-auto">
                    <div className="p-2 border-b border-neutral-800">
                        <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search currencies..."
                            className="w-full bg-neutral-950 border border-neutral-700 rounded px-2 py-1 text-sm text-neutral-200 focus:outline-none focus:border-cyan-500/50"
                            onClick={e => e.stopPropagation()}
                        />
                    </div>
                    {filteredCurrencies.map(c => (
                        <button
                            key={c.guid}
                            onClick={() => {
                                onChange(c.mnemonic);
                                setIsOpen(false);
                                setSearch('');
                            }}
                            className="w-full px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 transition-colors"
                        >
                            <span className="font-mono">{c.mnemonic}</span>
                            {c.fullname && <span className="text-neutral-500 ml-2">{c.fullname}</span>}
                        </button>
                    ))}
                    {filteredCurrencies.length === 0 && (
                        <div className="px-3 py-2 text-sm text-neutral-500">No currencies found</div>
                    )}
                </div>
            )}
        </div>
    );
}
