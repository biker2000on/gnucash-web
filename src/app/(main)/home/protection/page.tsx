'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type {
  CapitalAsset,
  CapitalProfile,
  InsurancePolicy,
  InsuranceProfile,
  LifePerson,
  LifeProfile,
} from '@/lib/resilience/types';
import { Empty, Field, INPUT, Metric, Panel, SaveBar, Tabs, TNUM } from '@/components/resilience/ui';

type Tab = 'insurance' | 'capital' | 'life';
const uid = () => crypto.randomUUID();
const currentYear = new Date().getFullYear();

interface InsuranceResponse {
  profile: InsuranceProfile;
  inventoryCount: number;
  analysis: {
    replacementValue: number;
    coverageLimit: number;
    gap: number;
    surplus: number;
    categoryGaps: Array<{ category: string; inventoryValue: number; limit: number; gap: number }>;
  };
}

interface CapitalResponse {
  profile: CapitalProfile;
  plan: {
    futureCost: number;
    fundingGap: number;
    monthlyFunding: number;
    rows: Array<CapitalAsset & {
      replacementYear: number;
      yearsRemaining: number;
      futureCost: number;
      fundingGap: number;
      monthlyFunding: number;
      overdue: boolean;
    }>;
  };
}

interface LifeResponse {
  profile: LifeProfile;
  analyses: Array<{
    person: LifePerson;
    dimeNeed: number;
    dimeGap: number;
    survivorNeed: number;
    survivorGap: number;
    recommendedCoverage: number;
  }>;
}

export default function ProtectionPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('insurance');
  const [insurance, setInsurance] = useState<InsuranceResponse | null>(null);
  const [capital, setCapital] = useState<CapitalResponse | null>(null);
  const [life, setLife] = useState<LifeResponse | null>(null);
  const [dirty, setDirty] = useState<Record<Tab, boolean>>({ insurance: false, capital: false, life: false });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [insuranceResponse, capitalResponse, lifeResponse] = await Promise.all([
      fetch('/api/resilience/insurance', { cache: 'no-store' }),
      fetch('/api/resilience/capital', { cache: 'no-store' }),
      fetch('/api/resilience/life', { cache: 'no-store' }),
    ]);
    if (!insuranceResponse.ok || !capitalResponse.ok || !lifeResponse.ok) throw new Error('Request failed');
    setInsurance(await insuranceResponse.json());
    setCapital(await capitalResponse.json());
    setLife(await lifeResponse.json());
    setDirty({ insurance: false, capital: false, life: false });
  };

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'capital' || requested === 'life' || requested === 'insurance') setTab(requested);
    load().catch(() => toast.error('Failed to load protection plan'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    const profile = tab === 'insurance' ? insurance?.profile : tab === 'capital' ? capital?.profile : life?.profile;
    if (!profile) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/resilience/${tab}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Save failed');
      if (tab === 'insurance') setInsurance(json);
      if (tab === 'capital') setCapital(json);
      if (tab === 'life') setLife(json);
      setDirty(current => ({ ...current, [tab]: false }));
      toast.success(`${tab === 'life' ? 'Life needs' : tab[0].toUpperCase() + tab.slice(1)} plan saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const addPolicy = () => {
    if (!insurance) return;
    const policy: InsurancePolicy = {
      id: uid(),
      type: 'home',
      provider: '',
      policyNumber: '',
      coveredEntity: 'Primary residence',
      coverageLimit: 0,
      deductible: 0,
      annualPremium: 0,
      renewalDate: `${currentYear + 1}-01-01`,
      sublimits: [],
      documentIds: [],
    };
    setInsurance({ ...insurance, profile: { policies: [...insurance.profile.policies, policy] } });
    setDirty(current => ({ ...current, insurance: true }));
  };

  const updatePolicy = (id: string, patch: Partial<InsurancePolicy>) => {
    if (!insurance) return;
    setInsurance({
      ...insurance,
      profile: { policies: insurance.profile.policies.map(policy => policy.id === id ? { ...policy, ...patch } : policy) },
    });
    setDirty(current => ({ ...current, insurance: true }));
  };

  const addCapital = () => {
    if (!capital) return;
    const asset: CapitalAsset = {
      id: uid(),
      name: '',
      category: 'Home system',
      installedYear: currentYear,
      expectedLifeYears: 15,
      currentReplacementCost: 0,
      inflationRate: 3,
      fundedAmount: 0,
      linkedHomeItemId: null,
    };
    setCapital({ ...capital, profile: { assets: [...capital.profile.assets, asset] } });
    setDirty(current => ({ ...current, capital: true }));
  };

  const updateCapital = (id: string, patch: Partial<CapitalAsset>) => {
    if (!capital) return;
    setCapital({
      ...capital,
      profile: { assets: capital.profile.assets.map(asset => asset.id === id ? { ...asset, ...patch } : asset) },
    });
    setDirty(current => ({ ...current, capital: true }));
  };

  const addPerson = () => {
    if (!life) return;
    const person: LifePerson = {
      id: uid(),
      name: '',
      annualIncome: 0,
      replacementYears: 10,
      debts: 0,
      educationGoals: 0,
      finalExpenses: 20_000,
      liquidAssets: 0,
      existingCoverage: 0,
      survivorAnnualIncome: 0,
      survivorAnnualExpenses: 0,
    };
    setLife({ ...life, profile: { people: [...life.profile.people, person] } });
    setDirty(current => ({ ...current, life: true }));
  };

  const updatePerson = (id: string, patch: Partial<LifePerson>) => {
    if (!life) return;
    setLife({
      ...life,
      profile: { people: life.profile.people.map(person => person.id === id ? { ...person, ...patch } : person) },
    });
    setDirty(current => ({ ...current, life: true }));
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Protection & Capital Plan"
        subtitle="Turn inventory, policies and replacement cycles into evidence-backed coverage and funding decisions."
        actions={
          <Link href="/api/resilience/claims-package" className="rounded-md border border-border px-3 py-2 text-sm text-primary hover:border-primary">
            Download claims package
          </Link>
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'insurance', label: 'Insurance coverage' },
        { value: 'capital', label: 'Capital replacement' },
        { value: 'life', label: 'Life insurance needs' },
      ]} />

      {tab === 'insurance' && insurance && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Inventory replacement value" value={formatCurrency(insurance.analysis.replacementValue)} />
            <Metric label="Property coverage" value={formatCurrency(insurance.analysis.coverageLimit)} />
            <Metric label="Coverage gap" value={formatCurrency(insurance.analysis.gap)} tone={insurance.analysis.gap > 0 ? 'negative' : 'positive'} />
            <Metric label="Documented items" value={insurance.inventoryCount} />
          </div>
          {insurance.analysis.categoryGaps.length > 0 && (
            <Panel title="Category sub-limit gaps" description="Inventory categories exceeding a matching policy sub-limit.">
              <div className="space-y-2">
                {insurance.analysis.categoryGaps.map(gap => (
                  <div key={gap.category} className="flex items-center justify-between border-b border-border/60 py-2 text-sm last:border-0">
                    <span>{gap.category}</span>
                    <span className="font-mono text-negative" style={TNUM}>{formatCurrency(gap.gap)} gap</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          <Panel title="Policies" action={<button type="button" onClick={addPolicy} className="text-sm text-primary">Add policy</button>}>
            {insurance.profile.policies.length === 0 ? <Empty>Add property, auto, umbrella, life or health coverage.</Empty> : (
              <div className="space-y-4">
                {insurance.profile.policies.map(policy => (
                  <div key={policy.id} className="rounded-md border border-border bg-background/50 p-4">
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      <Field label="Type"><select className={INPUT} value={policy.type} onChange={event => updatePolicy(policy.id, { type: event.target.value as InsurancePolicy['type'] })}>{['home','renters','auto','umbrella','life','health','other'].map(type => <option key={type}>{type}</option>)}</select></Field>
                      <Field label="Provider"><input className={INPUT} value={policy.provider} onChange={event => updatePolicy(policy.id, { provider: event.target.value })} /></Field>
                      <Field label="Covered entity"><input className={INPUT} value={policy.coveredEntity} onChange={event => updatePolicy(policy.id, { coveredEntity: event.target.value })} /></Field>
                      <Field label="Policy number"><input className={INPUT} value={policy.policyNumber} onChange={event => updatePolicy(policy.id, { policyNumber: event.target.value })} /></Field>
                      <Field label="Coverage limit"><input type="number" min="0" className={`${INPUT} font-mono`} value={policy.coverageLimit} onChange={event => updatePolicy(policy.id, { coverageLimit: Number(event.target.value) })} /></Field>
                      <Field label="Deductible"><input type="number" min="0" className={`${INPUT} font-mono`} value={policy.deductible} onChange={event => updatePolicy(policy.id, { deductible: Number(event.target.value) })} /></Field>
                      <Field label="Annual premium"><input type="number" min="0" className={`${INPUT} font-mono`} value={policy.annualPremium} onChange={event => updatePolicy(policy.id, { annualPremium: Number(event.target.value) })} /></Field>
                      <Field label="Renewal"><input type="date" className={`${INPUT} font-mono`} value={policy.renewalDate} onChange={event => updatePolicy(policy.id, { renewalDate: event.target.value })} /></Field>
                    </div>
                    <div className="mt-3 flex items-center justify-between">
                      <button type="button" onClick={() => updatePolicy(policy.id, { sublimits: [...policy.sublimits, { id: uid(), category: 'Jewelry', limit: 0 }] })} className="text-xs text-primary">Add category sub-limit</button>
                      <button type="button" onClick={() => {
                        setInsurance({ ...insurance, profile: { policies: insurance.profile.policies.filter(item => item.id !== policy.id) } });
                        setDirty(current => ({ ...current, insurance: true }));
                      }} className="text-xs text-foreground-muted hover:text-negative">Remove policy</button>
                    </div>
                    {policy.sublimits.map(sublimit => (
                      <div key={sublimit.id} className="mt-2 grid grid-cols-[1fr_1fr_auto] gap-2">
                        <input className={INPUT} value={sublimit.category} onChange={event => updatePolicy(policy.id, { sublimits: policy.sublimits.map(item => item.id === sublimit.id ? { ...item, category: event.target.value } : item) })} />
                        <input type="number" min="0" className={`${INPUT} font-mono`} value={sublimit.limit} onChange={event => updatePolicy(policy.id, { sublimits: policy.sublimits.map(item => item.id === sublimit.id ? { ...item, limit: Number(event.target.value) } : item) })} />
                        <button type="button" onClick={() => updatePolicy(policy.id, { sublimits: policy.sublimits.filter(item => item.id !== sublimit.id) })} className="px-2 text-negative">×</button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}

      {tab === 'capital' && capital && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Metric label="Projected replacement cost" value={formatCurrency(capital.plan.futureCost)} />
            <Metric label="Funding gap" value={formatCurrency(capital.plan.fundingGap)} tone={capital.plan.fundingGap > 0 ? 'warning' : 'positive'} />
            <Metric label="Monthly funding needed" value={formatCurrency(capital.plan.monthlyFunding)} />
          </div>
          <Panel title="Replacement schedule" description="Costs inflate to the expected replacement year and become Timeline events." action={<button type="button" onClick={addCapital} className="text-sm text-primary">Add asset</button>}>
            {capital.profile.assets.length === 0 ? <Empty>Add the roof, HVAC, water heater, appliances or other major systems.</Empty> : (
              <div className="space-y-3">
                {capital.profile.assets.map(asset => {
                  const calculated = capital.plan.rows.find(row => row.id === asset.id);
                  return (
                    <div key={asset.id} className="rounded-md border border-border bg-background/50 p-4">
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <Field label="Asset"><input className={INPUT} value={asset.name} onChange={event => updateCapital(asset.id, { name: event.target.value })} /></Field>
                        <Field label="Category"><input className={INPUT} value={asset.category} onChange={event => updateCapital(asset.id, { category: event.target.value })} /></Field>
                        <Field label="Installed year"><input type="number" className={`${INPUT} font-mono`} value={asset.installedYear} onChange={event => updateCapital(asset.id, { installedYear: Number(event.target.value) })} /></Field>
                        <Field label="Expected life (years)"><input type="number" min="1" className={`${INPUT} font-mono`} value={asset.expectedLifeYears} onChange={event => updateCapital(asset.id, { expectedLifeYears: Number(event.target.value) })} /></Field>
                        <Field label="Cost today"><input type="number" min="0" className={`${INPUT} font-mono`} value={asset.currentReplacementCost} onChange={event => updateCapital(asset.id, { currentReplacementCost: Number(event.target.value) })} /></Field>
                        <Field label="Inflation %"><input type="number" min="0" max="30" step="0.1" className={`${INPUT} font-mono`} value={asset.inflationRate} onChange={event => updateCapital(asset.id, { inflationRate: Number(event.target.value) })} /></Field>
                        <Field label="Already funded"><input type="number" min="0" className={`${INPUT} font-mono`} value={asset.fundedAmount} onChange={event => updateCapital(asset.id, { fundedAmount: Number(event.target.value) })} /></Field>
                        <div className="flex items-end justify-between gap-3">
                          <span className="pb-2 font-mono text-xs text-foreground-secondary" style={TNUM}>{calculated ? `${calculated.replacementYear} · ${formatCurrency(calculated.monthlyFunding)}/mo` : 'Save to calculate'}</span>
                          <button type="button" onClick={() => {
                            setCapital({ ...capital, profile: { assets: capital.profile.assets.filter(item => item.id !== asset.id) } });
                            setDirty(current => ({ ...current, capital: true }));
                          }} className="pb-2 text-xs text-foreground-muted hover:text-negative">Remove</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </>
      )}

      {tab === 'life' && life && (
        <>
          <Panel title="Coverage needs" description="Compares DIME with a survivor cash-flow model. This is planning support, not insurance advice." action={<button type="button" onClick={addPerson} className="text-sm text-primary">Add person</button>}>
            {life.profile.people.length === 0 ? <Empty>Add each income-earning or caregiving spouse.</Empty> : (
              <div className="space-y-4">
                {life.profile.people.map(person => {
                  const analysis = life.analyses.find(item => item.person.id === person.id);
                  return (
                    <div key={person.id} className="rounded-md border border-border bg-background/50 p-4">
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <Field label="Person"><input className={INPUT} value={person.name} onChange={event => updatePerson(person.id, { name: event.target.value })} /></Field>
                        {([
                          ['Annual income', 'annualIncome'],
                          ['Replacement years', 'replacementYears'],
                          ['Debts', 'debts'],
                          ['Education goals', 'educationGoals'],
                          ['Final expenses', 'finalExpenses'],
                          ['Liquid assets', 'liquidAssets'],
                          ['Existing coverage', 'existingCoverage'],
                          ['Survivor annual income', 'survivorAnnualIncome'],
                          ['Survivor annual expenses', 'survivorAnnualExpenses'],
                        ] as const).map(([label, key]) => (
                          <Field key={key} label={label}><input type="number" min="0" className={`${INPUT} font-mono`} value={person[key]} onChange={event => updatePerson(person.id, { [key]: Number(event.target.value) })} /></Field>
                        ))}
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <Metric label="DIME gap" value={analysis ? formatCurrency(analysis.dimeGap) : 'Save'} />
                        <Metric label="Survivor gap" value={analysis ? formatCurrency(analysis.survivorGap) : 'Save'} />
                        <Metric label="Recommended coverage" value={analysis ? formatCurrency(analysis.recommendedCoverage) : 'Save'} tone={analysis && analysis.recommendedCoverage > 0 ? 'warning' : 'positive'} />
                      </div>
                      <button type="button" onClick={() => {
                        setLife({ ...life, profile: { people: life.profile.people.filter(item => item.id !== person.id) } });
                        setDirty(current => ({ ...current, life: true }));
                      }} className="mt-3 text-xs text-foreground-muted hover:text-negative">Remove person</button>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </>
      )}
      <SaveBar saving={saving} dirty={dirty[tab]} onSave={save} />
    </div>
  );
}
