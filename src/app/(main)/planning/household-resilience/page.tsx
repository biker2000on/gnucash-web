'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { HealthcareClaim, HealthcarePlan, HealthcareProfile, PersonalPriceIndexItem } from '@/lib/resilience/types';
import { Empty, Field, INPUT, Metric, Panel, SaveBar, Tabs, TNUM } from '@/components/resilience/ui';

type Tab = 'prices' | 'healthcare';
const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

interface PriceIndexResponse {
  items: PersonalPriceIndexItem[];
  weightedChangePercent: number;
  observations: number;
  blsBenchmarks: Array<{ id: string; label: string; latestPeriod: string; yearOverYearPercent: number }>;
}

interface HealthcareResponse {
  profile: HealthcareProfile;
  comparison: Array<{
    plan: HealthcarePlan;
    allowed: number;
    memberMedicalCost: number;
    hsaTaxSavings: number;
    netAnnualCost: number;
    differenceFromBest: number;
  }>;
}

export default function HouseholdResiliencePage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('prices');
  const [prices, setPrices] = useState<PriceIndexResponse | null>(null);
  const [healthcare, setHealthcare] = useState<HealthcareResponse | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [priceResponse, healthResponse] = await Promise.all([
      fetch('/api/resilience/price-index', { cache: 'no-store' }),
      fetch('/api/resilience/healthcare', { cache: 'no-store' }),
    ]);
    if (!priceResponse.ok || !healthResponse.ok) throw new Error('Request failed');
    setPrices(await priceResponse.json());
    setHealthcare(await healthResponse.json());
    setDirty(false);
  };

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'healthcare') setTab('healthcare');
    load().catch(() => toast.error('Failed to load household resilience data'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateProfile = (profile: HealthcareProfile) => {
    if (!healthcare) return;
    setHealthcare({ ...healthcare, profile });
    setDirty(true);
  };

  const updatePlan = (id: string, patch: Partial<HealthcarePlan>) => {
    if (!healthcare) return;
    updateProfile({
      ...healthcare.profile,
      plans: healthcare.profile.plans.map(plan => plan.id === id ? { ...plan, ...patch } : plan),
    });
  };

  const updateClaim = (id: string, patch: Partial<HealthcareClaim>) => {
    if (!healthcare) return;
    updateProfile({
      ...healthcare.profile,
      claims: healthcare.profile.claims.map(claim => claim.id === id ? { ...claim, ...patch } : claim),
    });
  };

  const save = async () => {
    if (!healthcare) return;
    setSaving(true);
    try {
      const response = await fetch('/api/resilience/healthcare', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: healthcare.profile }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Save failed');
      setHealthcare(json);
      setDirty(false);
      toast.success('Healthcare comparison saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const addPlan = () => {
    if (!healthcare) return;
    const plan: HealthcarePlan = {
      id: uid(),
      name: 'Candidate plan',
      annualPremium: 0,
      familyDeductible: 0,
      coinsurancePercent: 20,
      outOfPocketMax: 0,
      employerHsaContribution: 0,
      employeeHsaContribution: 0,
      marginalTaxRate: 24,
      hsaEligible: false,
    };
    updateProfile({ ...healthcare.profile, plans: [...healthcare.profile.plans, plan] });
  };

  const addClaim = () => {
    if (!healthcare) return;
    const claim: HealthcareClaim = { id: uid(), date: today(), member: '', category: 'Medical', allowedAmount: 0 };
    updateProfile({ ...healthcare.profile, claims: [...healthcare.profile.claims, claim] });
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Household Resilience"
        subtitle="Your lived inflation and healthcare tradeoffs, calculated from household evidence."
      />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'prices', label: 'Personal Price Index' },
        { value: 'healthcare', label: 'Healthcare comparator' },
      ]} />

      {tab === 'prices' && prices && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Metric label="Tracked recurring items" value={prices.items.length} />
            <Metric label="Parsed receipt observations" value={prices.observations} />
            <Metric
              label="Weighted personal price change"
              value={`${prices.weightedChangePercent >= 0 ? '+' : ''}${prices.weightedChangePercent.toFixed(1)}%`}
              tone={prices.weightedChangePercent > 5 ? 'negative' : prices.weightedChangePercent < 0 ? 'positive' : undefined}
            />
          </div>
          <Panel title="Recurring item prices" description="Repeated OCR line items are normalized by product and unit; every row links back to source receipts.">
            {prices.items.length === 0 ? (
              <Empty>At least two comparable OCR receipt lines are needed before an item appears.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[10px] uppercase tracking-wider text-foreground-muted">
                    <tr><th className="pb-2">Item</th><th className="pb-2">Period</th><th className="pb-2 text-right">First</th><th className="pb-2 text-right">Latest</th><th className="pb-2 text-right">Change</th><th className="pb-2 text-right">Evidence</th></tr>
                  </thead>
                  <tbody>
                    {prices.items.map(item => (
                      <tr key={item.normalizedName} className="border-t border-border/60">
                        <td className="py-2 text-foreground">{item.latestName}</td>
                        <td className="py-2 font-mono text-xs text-foreground-secondary">{item.firstDate} → {item.latestDate}</td>
                        <td className="py-2 text-right font-mono">{formatCurrency(item.firstUnitPrice)}</td>
                        <td className="py-2 text-right font-mono">{formatCurrency(item.latestUnitPrice)}</td>
                        <td className={`py-2 text-right font-mono ${item.changePercent > 0 ? 'text-negative' : 'text-positive'}`} style={TNUM}>{item.changePercent >= 0 ? '+' : ''}{item.changePercent.toFixed(1)}%</td>
                        <td className="py-2 text-right"><a className="text-primary hover:underline" href={`/receipts?search=${encodeURIComponent(item.latestName)}`}>{item.observations} observations</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {prices.blsBenchmarks.length > 0 && (
            <Panel title="BLS CPI benchmark" description="Latest year-over-year U.S. city average from the official BLS public API. Personal item changes are not directly equivalent to category CPI.">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                {prices.blsBenchmarks.map(benchmark => (
                  <div key={benchmark.id} className="rounded-md border border-border p-3">
                    <p className="text-xs text-foreground-secondary">{benchmark.label}</p>
                    <p className="mt-1 font-mono text-lg text-foreground" style={TNUM}>{benchmark.yearOverYearPercent >= 0 ? '+' : ''}{benchmark.yearOverYearPercent.toFixed(1)}%</p>
                    <p className="text-[10px] text-foreground-muted">{benchmark.latestPeriod}</p>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </>
      )}

      {tab === 'healthcare' && healthcare && (
        <>
          {healthcare.comparison.length > 0 && (
            <Panel title="Claims replay" description="Entered allowed claims are replayed against each plan, including premiums, OOP limits, employer HSA funds and HSA tax effects.">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {healthcare.comparison.map((row, index) => (
                  <div key={row.plan.id} className={`rounded-lg border p-4 ${index === 0 ? 'border-primary bg-primary-light' : 'border-border'}`}>
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-foreground">{row.plan.name}</h3>
                      {index === 0 && <span className="text-[10px] font-semibold uppercase text-primary">Lowest modeled cost</span>}
                    </div>
                    <p className="mt-3 font-mono text-2xl text-foreground" style={TNUM}>{formatCurrency(row.netAnnualCost)}</p>
                    <div className="mt-2 space-y-1 text-xs text-foreground-secondary">
                      <p>Medical out of pocket: {formatCurrency(row.memberMedicalCost)}</p>
                      <p>HSA tax savings: {formatCurrency(row.hsaTaxSavings)}</p>
                      {row.differenceFromBest > 0 && <p className="text-warning">{formatCurrency(row.differenceFromBest)} above best</p>}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel title="Candidate plans" action={<button type="button" onClick={addPlan} className="text-sm text-primary">Add plan</button>}>
            {healthcare.profile.plans.length === 0 ? <Empty>Add the current plan and each open-enrollment candidate.</Empty> : (
              <div className="space-y-3">
                {healthcare.profile.plans.map(plan => (
                  <div key={plan.id} className="rounded-md border border-border bg-background/50 p-4">
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <Field label="Plan"><input className={INPUT} value={plan.name} onChange={event => updatePlan(plan.id, { name: event.target.value })} /></Field>
                      {([
                        ['Annual premium', 'annualPremium'],
                        ['Family deductible', 'familyDeductible'],
                        ['Coinsurance %', 'coinsurancePercent'],
                        ['Out-of-pocket max', 'outOfPocketMax'],
                        ['Employer HSA', 'employerHsaContribution'],
                        ['Employee HSA', 'employeeHsaContribution'],
                        ['Marginal tax rate %', 'marginalTaxRate'],
                      ] as const).map(([label, key]) => (
                        <Field key={key} label={label}><input type="number" min="0" className={`${INPUT} font-mono`} value={plan[key]} onChange={event => updatePlan(plan.id, { [key]: Number(event.target.value) })} /></Field>
                      ))}
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <label className="flex items-center gap-2 text-sm text-foreground-secondary"><input type="checkbox" checked={plan.hsaEligible} onChange={event => updatePlan(plan.id, { hsaEligible: event.target.checked })} /> HSA eligible</label>
                      <div className="flex gap-3">
                        <label className="flex items-center gap-2 text-xs text-foreground-secondary"><input type="radio" name="current-plan" checked={healthcare.profile.currentPlanId === plan.id} onChange={() => updateProfile({ ...healthcare.profile, currentPlanId: plan.id })} /> Current plan</label>
                        <button type="button" onClick={() => updateProfile({ ...healthcare.profile, plans: healthcare.profile.plans.filter(item => item.id !== plan.id) })} className="text-xs text-foreground-muted hover:text-negative">Remove</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Actual claims" description="Use allowed amounts, not provider sticker prices." action={<button type="button" onClick={addClaim} className="text-sm text-primary">Add claim</button>}>
            {healthcare.profile.claims.length === 0 ? <Empty>Add claims or representative annual usage to compare plans.</Empty> : (
              <div className="space-y-2">
                {healthcare.profile.claims.map(claim => (
                  <div key={claim.id} className="grid grid-cols-2 gap-2 rounded-md border border-border bg-background/50 p-3 sm:grid-cols-[140px_1fr_1fr_160px_auto]">
                    <input type="date" className={`${INPUT} font-mono`} value={claim.date} onChange={event => updateClaim(claim.id, { date: event.target.value })} />
                    <input className={INPUT} placeholder="Family member" value={claim.member} onChange={event => updateClaim(claim.id, { member: event.target.value })} />
                    <input className={INPUT} placeholder="Category" value={claim.category} onChange={event => updateClaim(claim.id, { category: event.target.value })} />
                    <input type="number" min="0" className={`${INPUT} font-mono`} value={claim.allowedAmount} onChange={event => updateClaim(claim.id, { allowedAmount: Number(event.target.value) })} />
                    <button type="button" onClick={() => updateProfile({ ...healthcare.profile, claims: healthcare.profile.claims.filter(item => item.id !== claim.id) })} className="px-2 text-negative">×</button>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <SaveBar saving={saving} dirty={dirty} onSave={save} />
        </>
      )}
    </div>
  );
}
