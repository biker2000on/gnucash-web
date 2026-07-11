'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { RebalanceTarget } from '@/lib/rebalancing';
import type { RebalanceMode } from '@/lib/rebalancing-sector';
import type { RebalanceData } from './types';
import { TargetEditor } from './TargetEditor';
import { DriftBars } from './DriftBars';
import { SuggestionsTable } from './SuggestionsTable';
import { SectorSuggestionsTable } from './SectorSuggestionsTable';

function parseTargets(inputs: Record<string, string>): RebalanceTarget[] {
    return Object.entries(inputs)
        .map(([key, value]) => ({ key, targetPct: parseFloat(value) }))
        .filter(t => Number.isFinite(t.targetPct) && t.targetPct > 0);
}

function sameTargets(a: RebalanceTarget[], b: RebalanceTarget[]): boolean {
    if (a.length !== b.length) return false;
    const bMap = new Map(b.map(t => [t.key, t.targetPct]));
    return a.every(t => Math.abs((bMap.get(t.key) ?? -1) - t.targetPct) < 0.001);
}

function inputsFromTargets(targets: RebalanceTarget[]): Record<string, string> {
    const inputs: Record<string, string> = {};
    for (const t of targets) inputs[t.key] = String(t.targetPct);
    return inputs;
}

export default function RebalancingPage() {
    const { success, error: showError } = useToast();

    const [data, setData] = useState<RebalanceData | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [fetchingMeta, setFetchingMeta] = useState(false);
    const [mode, setMode] = useState<RebalanceMode>('symbol');

    const [targetInputs, setTargetInputs] = useState<Record<string, string>>({});
    const [newCashInput, setNewCashInput] = useState('');
    const [bandInput, setBandInput] = useState('5');

    const initialized = useRef(false);
    const skipPreview = useRef(false);
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const requestSeq = useRef(0);
    const targetInputsRef = useRef(targetInputs);
    targetInputsRef.current = targetInputs;

    const buildQuery = useCallback((preview: boolean, modeParam: RebalanceMode | null): string => {
        const params = new URLSearchParams();
        if (modeParam) params.set('mode', modeParam);
        const cash = parseFloat(newCashInput);
        if (Number.isFinite(cash) && cash > 0) params.set('newCash', String(cash));
        const band = parseFloat(bandInput);
        if (Number.isFinite(band) && band >= 0) params.set('band', String(band));
        if (preview) params.set('targets', JSON.stringify(parseTargets(targetInputsRef.current)));
        const qs = params.toString();
        return qs ? `?${qs}` : '';
    }, [newCashInput, bandInput]);

    const fetchData = useCallback(async (preview: boolean, modeParam: RebalanceMode | null) => {
        const seq = ++requestSeq.current;
        try {
            const res = await fetch(`/api/investments/rebalance${buildQuery(preview, modeParam)}`);
            if (!res.ok) throw new Error('Request failed');
            const json: RebalanceData = await res.json();
            if (seq !== requestSeq.current) return; // stale response
            setData(json);
            if (!initialized.current) {
                // Adopt the saved mode and seed editable state from saved targets
                setMode(json.allocationMode);
                setTargetInputs(inputsFromTargets(json.savedTargets));
                setBandInput(String(json.savedBandPct));
                initialized.current = true;
            }
        } catch {
            if (seq === requestSeq.current) showError('Failed to load rebalancing data');
        }
    }, [buildQuery, showError]);

    // Initial load (saved mode + targets, no preview)
    useEffect(() => {
        void fetchData(false, null).finally(() => setLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Debounced live preview when inputs change
    useEffect(() => {
        if (!initialized.current) return;
        if (skipPreview.current) {
            // A mode switch just reseeded the inputs — its own fetch is in flight.
            skipPreview.current = false;
            return;
        }
        setRefreshing(true);
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
            void fetchData(true, mode).finally(() => setRefreshing(false));
        }, 400);
        return () => {
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetInputs, newCashInput, bandInput, fetchData]);

    const handleTargetChange = useCallback((key: string, value: string) => {
        setTargetInputs(prev => ({ ...prev, [key]: value }));
    }, []);

    const handleModeChange = useCallback((next: RebalanceMode) => {
        if (next === mode || !data) return;
        setMode(next);
        // Reseed inputs from the other mode's saved targets and refetch
        skipPreview.current = true;
        setTargetInputs(inputsFromTargets(
            next === 'sector' ? data.savedTargetsBySector : data.savedTargetsBySymbol
        ));
        setRefreshing(true);
        void fetchData(false, next).finally(() => setRefreshing(false));
    }, [mode, data, fetchData]);

    const editedTargets = useMemo(() => parseTargets(targetInputs), [targetInputs]);
    const bandValue = useMemo(() => {
        const b = parseFloat(bandInput);
        return Number.isFinite(b) && b >= 0 ? b : 5;
    }, [bandInput]);

    const dirty = data !== null && (
        !sameTargets(editedTargets, data.savedTargets) ||
        Math.abs(bandValue - data.savedBandPct) > 0.001 ||
        mode !== data.savedMode
    );

    const handleSave = useCallback(async () => {
        if (saving) return;
        setSaving(true);
        try {
            const res = await fetch('/api/investments/rebalance', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode, targets: editedTargets, bandPct: bandValue }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || 'Save failed');
            }
            success('Target allocation saved');
            await fetchData(false, mode);
        } catch (e) {
            showError(e instanceof Error ? e.message : 'Failed to save targets');
        } finally {
            setSaving(false);
        }
    }, [saving, mode, editedTargets, bandValue, success, showError, fetchData]);

    const handleFetchSectorData = useCallback(async () => {
        if (fetchingMeta) return;
        setFetchingMeta(true);
        try {
            const res = await fetch('/api/investments/commodity-metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbols: data?.unclassifiedSymbols ?? [] }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || 'Fetch failed');
            }
            const json = await res.json();
            success(`Sector data refreshed — ${json.refreshed} updated, ${json.failed} unavailable`);
            setRefreshing(true);
            await fetchData(true, mode).finally(() => setRefreshing(false));
        } catch (e) {
            showError(e instanceof Error ? e.message : 'Failed to fetch sector data');
        } finally {
            setFetchingMeta(false);
        }
    }, [fetchingMeta, data, mode, success, showError, fetchData]);

    if (loading) {
        return (
            <div className="space-y-6">
                <div className="h-8 bg-background-tertiary rounded animate-pulse w-48" />
                <div className="h-40 bg-background-tertiary rounded-lg animate-pulse" />
                <div className="h-64 bg-background-tertiary rounded-lg animate-pulse" />
            </div>
        );
    }

    if (!data || data.holdings.length === 0) {
        return (
            <div className="space-y-6">
                <PageHeader title="Rebalancing" subtitle="Target allocation, drift, and tax-aware suggestions" />
                <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
                    <p className="text-foreground-secondary text-lg mb-2">No holdings to rebalance</p>
                    <p className="text-foreground-muted">
                        Investment holdings (STOCK/MUTUAL accounts) will appear here once present in GnuCash.
                    </p>
                </div>
            </div>
        );
    }

    const sectorMode = mode === 'sector';
    const unclassified = sectorMode ? (data.unclassifiedSymbols ?? []) : [];

    return (
        <div className="space-y-6">
            <PageHeader
                title="Rebalancing"
                subtitle="Target allocation, drift, and tax-aware suggestions"
                actions={
                    <button
                        onClick={handleSave}
                        disabled={!dirty || saving}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/30 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                    >
                        {saving ? 'Saving…' : dirty ? 'Save Targets' : 'Targets Saved'}
                    </button>
                }
            />

            {/* Controls */}
            <div className="bg-background-secondary rounded-lg border border-border p-4 flex flex-wrap items-end gap-x-6 gap-y-3">
                <div>
                    <div className="text-xs uppercase tracking-wider text-foreground-muted mb-1">
                        Portfolio Value
                    </div>
                    <div className="font-mono tabular-nums text-lg font-semibold text-foreground">
                        {formatCurrency(data.totalValue)}
                    </div>
                </div>
                <div>
                    <div className="text-xs uppercase tracking-wider text-foreground-muted mb-1">
                        Allocate By
                    </div>
                    <div className="inline-flex rounded border border-border overflow-hidden">
                        {(['symbol', 'sector'] as const).map(m => (
                            <button
                                key={m}
                                onClick={() => handleModeChange(m)}
                                aria-pressed={mode === m}
                                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                                    mode === m
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-background-tertiary text-foreground-secondary hover:bg-surface-hover'
                                }`}
                            >
                                {m === 'symbol' ? 'Symbol' : 'Sector'}
                            </button>
                        ))}
                    </div>
                </div>
                <label className="block">
                    <span className="text-xs uppercase tracking-wider text-foreground-muted block mb-1">
                        New Cash to Invest
                    </span>
                    <div className="flex items-center gap-1">
                        <span className="text-foreground-muted text-sm">$</span>
                        <input
                            type="number"
                            min={0}
                            step={100}
                            inputMode="decimal"
                            value={newCashInput}
                            placeholder="0"
                            onChange={e => setNewCashInput(e.target.value)}
                            className="w-32 bg-input-bg border border-border rounded px-2 py-1.5 text-right font-mono tabular-nums text-sm text-foreground focus:outline-none focus:border-primary/50"
                        />
                    </div>
                </label>
                <label className="block">
                    <span className="text-xs uppercase tracking-wider text-foreground-muted block mb-1">
                        Drift Band (± pts)
                    </span>
                    <input
                        type="number"
                        min={0}
                        max={50}
                        step={1}
                        inputMode="decimal"
                        value={bandInput}
                        onChange={e => setBandInput(e.target.value)}
                        className="w-20 bg-input-bg border border-border rounded px-2 py-1.5 text-right font-mono tabular-nums text-sm text-foreground focus:outline-none focus:border-primary/50"
                    />
                </label>
                {data.mode === 'buy-only' && (
                    <span className="text-xs px-2 py-1 rounded bg-secondary-light text-secondary">
                        Buy-only mode — new cash covers rebalancing
                    </span>
                )}
                {refreshing && (
                    <span className="text-xs text-foreground-muted">Recalculating…</span>
                )}
            </div>

            {/* Missing sector data callout */}
            {sectorMode && unclassified.length > 0 && (
                <div className="bg-secondary-light border border-secondary/30 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-foreground-secondary">
                        No sector data for{' '}
                        <span className="font-mono text-foreground">{unclassified.join(', ')}</span>
                        {' '}— their value is shown under &ldquo;Unclassified&rdquo;.
                    </p>
                    <button
                        onClick={handleFetchSectorData}
                        disabled={fetchingMeta}
                        className="px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover disabled:bg-primary/30 disabled:cursor-not-allowed text-primary-foreground rounded transition-colors"
                    >
                        {fetchingMeta ? 'Fetching…' : 'Fetch sector data'}
                    </button>
                </div>
            )}

            {/* Warnings */}
            {data.warnings.length > 0 && (
                <div className="bg-warning/10 border border-warning/30 rounded-lg px-4 py-3 space-y-1">
                    {data.warnings.map((w, i) => (
                        <p key={i} className="text-sm text-warning">{w}</p>
                    ))}
                </div>
            )}

            {/* Drift bars */}
            <DriftBars
                rows={data.rows}
                bandPct={data.bandPct}
                keyWidthClass={sectorMode ? 'w-40' : 'w-16'}
            />

            {/* Target editor */}
            <TargetEditor
                rows={data.rows}
                targetInputs={targetInputs}
                onTargetChange={handleTargetChange}
                keyHeader={sectorMode ? 'Sector' : 'Symbol'}
            />

            {/* Suggestions */}
            {sectorMode ? (
                <>
                    <SectorSuggestionsTable
                        groups={data.sectorGroups ?? []}
                        netBySymbol={data.symbolTrades ?? []}
                        mode={data.mode}
                    />
                    {(data.symbolTrades?.length ?? 0) > 0 && (
                        <SuggestionsTable
                            suggestions={data.symbolTrades ?? []}
                            mode={data.mode}
                            title="Net Trades by Symbol (Tax Impact)"
                        />
                    )}
                </>
            ) : (
                <SuggestionsTable suggestions={data.suggestions} mode={data.mode} />
            )}
        </div>
    );
}
