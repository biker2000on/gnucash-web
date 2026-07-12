'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { STATE_OPTIONS } from '@/lib/tax/state';
import {
    FILING_STATUS_LABELS,
    FILING_STATUSES,
    type FilingStatus,
} from '@/lib/tax/types';
import type {
    SellPlanComparison,
    SellPlannerAccount,
    SellStrategy,
    SellTaxContextMeta,
} from '@/lib/sell-planner';
import PlanComparisonCards from './PlanComparisonCards';
import PlanLotTable from './PlanLotTable';

const MONO = { fontFeatureSettings: "'tnum'" } as const;

interface PrefillPayload {
    accounts: SellPlannerAccount[];
    retirement: { totalMarketValue: number; accountCount: number };
    taxableMarketValue: number;
    candidateLotCount: number;
    recentBuysByTicker: Record<string, string>;
    missingPriceTickers: string[];
    context: SellTaxContextMeta;
}

interface PlanPayload {
    asOf: string;
    plans: SellPlanComparison;
    retirement: { totalMarketValue: number; accountCount: number };
    missingPriceTickers: string[];
    context: SellTaxContextMeta;
}

function Section({ title, subtitle, children }: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
}) {
    return (
        <section className="bg-surface/30 border border-border rounded-lg p-5 space-y-4">
            <div>
                <h2 className="text-base font-semibold text-foreground">{title}</h2>
                {subtitle && <p className="text-xs text-foreground-muted mt-0.5">{subtitle}</p>}
            </div>
            {children}
        </section>
    );
}

const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;

export default function SellPlannerPage() {
    const [prefill, setPrefill] = useState<PrefillPayload | null>(null);
    const [prefillError, setPrefillError] = useState<string | null>(null);

    const [target, setTarget] = useState('');
    const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
    const [filingStatus, setFilingStatus] = useState<FilingStatus>('single');
    const [stateCode, setStateCode] = useState('OTHER');
    const [stateFlatRate, setStateFlatRate] = useState(0);

    const [computing, setComputing] = useState(false);
    const [planError, setPlanError] = useState<string | null>(null);
    const [result, setResult] = useState<PlanPayload | null>(null);
    const [selectedPlan, setSelectedPlan] = useState<SellStrategy>('recommended');

    /* --- Prefill --- */
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/tools/sell-planner');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data: PrefillPayload = await res.json();
                if (cancelled) return;
                setPrefill(data);
                setFilingStatus(data.context.filingStatus);
                setStateCode(data.context.stateCode);
                setStateFlatRate(data.context.stateFlatRate);
                setSelectedAccounts(
                    new Set(data.accounts.filter(a => !a.isRetirement && a.hasPrice).map(a => a.guid)),
                );
            } catch (err) {
                console.error('Sell planner prefill failed:', err);
                if (!cancelled) setPrefillError('Failed to load holdings and tax context.');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const taxableAccounts = useMemo(
        () => (prefill?.accounts ?? []).filter(a => !a.isRetirement),
        [prefill],
    );

    const toggleAccount = (guid: string) => {
        setSelectedAccounts(prev => {
            const next = new Set(prev);
            if (next.has(guid)) next.delete(guid);
            else next.add(guid);
            return next;
        });
    };

    const targetNumber = parseFloat(target.replace(/[$,\s]/g, ''));
    const targetValid = Number.isFinite(targetNumber) && targetNumber > 0;

    /* --- Compute --- */
    const compute = useCallback(async () => {
        if (!targetValid) return;
        setComputing(true);
        setPlanError(null);
        try {
            const res = await fetch('/api/tools/sell-planner', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetCash: targetNumber,
                    accountGuids: [...selectedAccounts],
                    filingStatus,
                    stateCode,
                    stateFlatRate: stateCode === 'OTHER' ? stateFlatRate : undefined,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error ?? `HTTP ${res.status}`);
            }
            const data: PlanPayload = await res.json();
            setResult(data);
            setSelectedPlan('recommended');
        } catch (err) {
            console.error('Sell plan failed:', err);
            setPlanError(err instanceof Error ? err.message : 'Failed to build the plan.');
        } finally {
            setComputing(false);
        }
    }, [targetValid, targetNumber, selectedAccounts, filingStatus, stateCode, stateFlatRate]);

    const activePlan = result
        ? selectedPlan === 'recommended'
            ? result.plans.recommended
            : selectedPlan === 'fifo'
                ? result.plans.fifo
                : result.plans.longTermOnly
        : null;

    return (
        <div className="space-y-6 max-w-[1400px]">
            <header>
                <h1 className="text-3xl font-bold text-foreground">Tax-Optimal Sell Planner</h1>
                <p className="text-foreground-muted mt-1">
                    I need to raise $X — which lots do I sell, and what will it cost in tax?
                </p>
            </header>

            {prefillError && (
                <div className="bg-error/10 border border-error/30 rounded-lg p-4 text-sm text-error">
                    {prefillError}
                </div>
            )}

            {!prefill && !prefillError && (
                <p className="text-sm text-foreground-muted">Loading holdings and tax context…</p>
            )}

            {prefill && (
                <>
                    <Section
                        title="Target"
                        subtitle={`Taxable holdings with lots: ${formatCurrency(prefill.taxableMarketValue)} across ${prefill.candidateLotCount} open lots.`}
                    >
                        <div className="flex flex-wrap items-end gap-4">
                            <label className="block">
                                <span className="text-xs text-foreground-muted uppercase tracking-wide">Cash to raise</span>
                                <input
                                    type="text"
                                    inputMode="decimal"
                                    value={target}
                                    onChange={e => setTarget(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') compute(); }}
                                    placeholder="25,000"
                                    className="mt-1 block w-44 bg-background border border-border rounded-md px-3 py-2 font-mono text-lg text-foreground focus:outline-none focus:border-primary"
                                    style={MONO}
                                />
                            </label>
                            <label className="block">
                                <span className="text-xs text-foreground-muted uppercase tracking-wide">Filing status</span>
                                <select
                                    value={filingStatus}
                                    onChange={e => setFilingStatus(e.target.value as FilingStatus)}
                                    className="mt-1 block bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                                >
                                    {FILING_STATUSES.map(fs => (
                                        <option key={fs} value={fs}>{FILING_STATUS_LABELS[fs]}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="block">
                                <span className="text-xs text-foreground-muted uppercase tracking-wide">State</span>
                                <select
                                    value={stateCode}
                                    onChange={e => setStateCode(e.target.value)}
                                    className="mt-1 block bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                                >
                                    {STATE_OPTIONS.map(s => (
                                        <option key={s.code} value={s.code}>{s.name}</option>
                                    ))}
                                </select>
                            </label>
                            {stateCode === 'OTHER' && (
                                <label className="block">
                                    <span className="text-xs text-foreground-muted uppercase tracking-wide">Flat state rate %</span>
                                    <input
                                        type="number"
                                        min={0}
                                        max={20}
                                        step={0.1}
                                        value={stateFlatRate * 100}
                                        onChange={e => setStateFlatRate(Math.max(0, parseFloat(e.target.value) || 0) / 100)}
                                        className="mt-1 block w-28 bg-background border border-border rounded-md px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary"
                                        style={MONO}
                                    />
                                </label>
                            )}
                            <button
                                type="button"
                                onClick={compute}
                                disabled={!targetValid || computing || selectedAccounts.size === 0}
                                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40 hover:bg-primary-hover transition-colors duration-150"
                            >
                                {computing ? 'Computing…' : 'Build sell plan'}
                            </button>
                        </div>

                        <p className="text-xs text-foreground-muted">
                            {prefill.context.year} baseline: {FILING_STATUS_LABELS[prefill.context.filingStatus]},
                            YTD realized gains {formatCurrency(prefill.context.ytdShortTermGains)} ST
                            {' / '}{formatCurrency(prefill.context.ytdLongTermGains)} LT,
                            marginal rate {pct(prefill.context.marginalRate, 0)}.
                        </p>
                    </Section>

                    <Section
                        title="Accounts in scope"
                        subtitle="Taxable STOCK/MUTUAL accounts. Retirement-flagged accounts are excluded — selling inside them has no capital-gains consequence."
                    >
                        {taxableAccounts.length === 0 ? (
                            <p className="text-sm text-foreground-muted">
                                No taxable investment accounts with open lots were found.
                            </p>
                        ) : (
                            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                                {taxableAccounts.map(a => (
                                    <label
                                        key={a.guid}
                                        className={`flex items-center gap-2 px-3 py-2 rounded-md border cursor-pointer transition-colors duration-150 ${
                                            selectedAccounts.has(a.guid)
                                                ? 'border-primary/50 bg-primary-light'
                                                : 'border-border bg-surface hover:border-border-hover'
                                        } ${!a.hasPrice ? 'opacity-50' : ''}`}
                                        title={a.path}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selectedAccounts.has(a.guid)}
                                            onChange={() => toggleAccount(a.guid)}
                                            disabled={!a.hasPrice}
                                            className="accent-[var(--primary)]"
                                        />
                                        <span className="flex-1 min-w-0 text-sm text-foreground truncate">
                                            {a.ticker} <span className="text-foreground-muted">· {a.name}</span>
                                        </span>
                                        <span className="font-mono text-xs text-foreground-secondary" style={MONO}>
                                            {formatCurrency(a.marketValue)}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}

                        {prefill.retirement.accountCount > 0 && (
                            <p className="text-xs text-foreground-muted">
                                Also available: {formatCurrency(prefill.retirement.totalMarketValue)} in{' '}
                                {prefill.retirement.accountCount} retirement account
                                {prefill.retirement.accountCount === 1 ? '' : 's'} — <span className="text-foreground-secondary">
                                tax-free to sell</span> (no capital gains inside an IRA/401k), though withdrawing
                                the cash may be taxed separately.
                            </p>
                        )}
                        {prefill.missingPriceTickers.length > 0 && (
                            <p className="text-xs text-warning">
                                No current price for: {prefill.missingPriceTickers.join(', ')} — those lots are excluded.
                            </p>
                        )}
                    </Section>

                    {planError && (
                        <div className="bg-error/10 border border-error/30 rounded-lg p-4 text-sm text-error">
                            {planError}
                        </div>
                    )}

                    {result && activePlan && (
                        <>
                            <Section
                                title="Plan comparison"
                                subtitle={`Raising ${formatCurrency(result.plans.recommended.targetCash)} · incremental ${result.context.year} federal + state tax vs your baseline.`}
                            >
                                <PlanComparisonCards
                                    plans={result.plans}
                                    selected={selectedPlan}
                                    onSelect={setSelectedPlan}
                                />
                            </Section>

                            <Section
                                title={`Lots to sell — ${activePlan.label}`}
                                subtitle={`As of ${result.asOf}. Harvested losses ${formatCurrency(activePlan.harvestedLoss)} · net realized gain ${formatCurrency(activePlan.netGain)}.`}
                            >
                                <PlanLotTable plan={activePlan} />

                                {activePlan.warnings.length > 0 && (
                                    <ul className="space-y-1">
                                        {activePlan.warnings.map((w, i) => (
                                            <li key={i} className="text-xs text-warning">{w}</li>
                                        ))}
                                    </ul>
                                )}
                            </Section>

                            <footer className="text-[11px] text-foreground-muted leading-relaxed border border-border rounded-lg p-4 bg-surface/30">
                                <p className="font-medium text-foreground-secondary mb-1">Assumptions</p>
                                <p>
                                    Estimates only — not tax advice. Tax cost is incremental: federal tax at
                                    baseline income plus plan gains, minus baseline tax, honoring ST/LT netting,
                                    the $3,000 capital-loss cap, long-term capital gains bracket stacking, and
                                    the 3.8% NIIT; state tax is approximated on federal AGI at your configured
                                    state ({result.context.stateCode}), so states are assumed to tax ST and LT
                                    gains alike. Baseline income is your year-to-date book data
                                    {result.context.annualized ? ', annualized to a full-year estimate,' : ''} plus
                                    realized gains so far. Lot basis and holding period come from your GnuCash
                                    lots (transfer-aware acquisition dates); proceeds use the latest stored
                                    price. Wash-sale screening looks back 30 days across all accounts
                                    (including IRAs) — do not repurchase a sold-at-a-loss security within 30
                                    days after selling, or the loss will be disallowed. Commissions, AMT, and
                                    state-specific capital-gains rules are not modeled.
                                </p>
                            </footer>
                        </>
                    )}
                </>
            )}
        </div>
    );
}
