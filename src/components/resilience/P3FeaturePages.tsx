'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type {
  EducationChild,
  EducationProfile,
  FamilyBankChild,
  FamilyBankEntryKind,
  FamilyBankingProfile,
  TripPlan,
  TripsProfile,
  UtilitiesProfile,
  UtilityBill,
  VehicleTcoAsset,
  VehicleTcoProfile,
} from '@/lib/resilience/types';
import { Empty, Field, INPUT, Metric, Panel, SaveBar, Tabs, TNUM } from './ui';

const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const numberValue = (value: string) => Number(value) || 0;

function useSection<P, R extends { profile: P }>(section: string, initial: P) {
  const toast = useToast();
  const [response, setResponse] = useState<R | null>(null);
  const [profile, setProfile] = useState<P>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const result = await fetch(`/api/resilience/${section}`, { cache: 'no-store' });
    const json = await result.json();
    if (!result.ok) throw new Error(json.error || 'Request failed');
    setResponse(json as R);
    setProfile((json as R).profile);
    setDirty(false);
  };

  useEffect(() => {
    load().catch(() => toast.error(`Failed to load ${section.replaceAll('_', ' ')}`)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  const change = (next: P) => {
    setProfile(next);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await fetch(`/api/resilience/${section}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const json = await result.json();
      if (!result.ok) throw new Error(json.error || 'Save failed');
      setResponse(json as R);
      setProfile((json as R).profile);
      setDirty(false);
      toast.success('Changes saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return { response, profile, change, dirty, saving, loading, save };
}

type EducationResult = EducationChild & {
  projectedCost: number;
  projected529Balance: number;
  fundingGap: number;
  requiredMonthlyContribution: number;
  monthlyShortfall: number;
  contributedThisYear: number;
  stateDeductionRemaining: number;
  glidePath: { equityPercent: number; fixedIncomePercent: number; guidance: string };
};

export function EducationPlannerPage() {
  const state = useSection<EducationProfile, { profile: EducationProfile; plans: EducationResult[] }>(
    'education',
    { children: [] },
  );
  const [contributions, setContributions] = useState<Record<string, string>>({});
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading education plans…</div>;
  const update = (id: string, patch: Partial<EducationChild>) =>
    state.change({ children: state.profile.children.map(child => child.id === id ? { ...child, ...patch } : child) });
  const addChild = () => {
    const year = new Date().getFullYear();
    state.change({ children: [...state.profile.children, {
      id: uid(), name: 'New student', birthYear: year - 5, collegeStartYear: year + 13,
      schoolType: 'public_in_state', yearsOfSchool: 4, annualCostToday: 30_000,
      tuitionInflationRate: 5, current529Balance: 0, expectedAnnualReturn: 6,
      plannedMonthlyContribution: 250, stateDeductionLimit: 0, contributions: [],
    }] });
  };
  const recordContribution = (child: EducationChild) => {
    const amount = numberValue(contributions[child.id] ?? '');
    if (amount <= 0) return;
    update(child.id, { contributions: [...child.contributions, { id: uid(), date: today(), amount }] });
    setContributions(current => ({ ...current, [child.id]: '' }));
  };
  const totals = state.response?.plans ?? [];
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader title="Education & 529 Planner" subtitle="Per-child tuition projections, contribution targets, state deduction tracking, and glide-path guidance." actions={<button type="button" onClick={addChild} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add student</button>} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric label="Projected education cost" value={formatCurrency(totals.reduce((sum, row) => sum + row.projectedCost, 0))} />
        <Metric label="Projected 529 value" value={formatCurrency(totals.reduce((sum, row) => sum + row.projected529Balance, 0))} tone="positive" />
        <Metric label="Funding gap" value={formatCurrency(totals.reduce((sum, row) => sum + row.fundingGap, 0))} tone={totals.some(row => row.fundingGap > 0) ? 'warning' : 'positive'} />
      </div>
      {state.profile.children.length === 0 ? <Empty>Add a child or student to model an education path.</Empty> : state.profile.children.map(child => {
        const result = state.response?.plans.find(row => row.id === child.id);
        return (
          <Panel key={child.id} title={child.name} description={result ? `${result.glidePath.equityPercent}% growth / ${result.glidePath.fixedIncomePercent}% preservation guidance` : undefined} action={<button type="button" onClick={() => state.change({ children: state.profile.children.filter(item => item.id !== child.id) })} className="text-xs text-negative">Remove</button>}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Field label="Student"><input className={INPUT} value={child.name} onChange={event => update(child.id, { name: event.target.value })} /></Field>
              <Field label="College start"><input type="number" className={`${INPUT} font-mono`} value={child.collegeStartYear} onChange={event => update(child.id, { collegeStartYear: numberValue(event.target.value) })} /></Field>
              <Field label="School type"><select className={INPUT} value={child.schoolType} onChange={event => update(child.id, { schoolType: event.target.value as EducationChild['schoolType'] })}><option value="public_in_state">Public in-state</option><option value="public_out_of_state">Public out-of-state</option><option value="private">Private</option></select></Field>
              <Field label="Years"><input type="number" min="1" max="10" className={`${INPUT} font-mono`} value={child.yearsOfSchool} onChange={event => update(child.id, { yearsOfSchool: numberValue(event.target.value) })} /></Field>
              <Field label="Annual cost today"><input type="number" className={`${INPUT} font-mono`} value={child.annualCostToday} onChange={event => update(child.id, { annualCostToday: numberValue(event.target.value) })} /></Field>
              <Field label="Tuition inflation %"><input type="number" step="0.1" className={`${INPUT} font-mono`} value={child.tuitionInflationRate} onChange={event => update(child.id, { tuitionInflationRate: numberValue(event.target.value) })} /></Field>
              <Field label="Current 529 balance"><input type="number" className={`${INPUT} font-mono`} value={child.current529Balance} onChange={event => update(child.id, { current529Balance: numberValue(event.target.value) })} /></Field>
              <Field label="Expected return %"><input type="number" step="0.1" className={`${INPUT} font-mono`} value={child.expectedAnnualReturn} onChange={event => update(child.id, { expectedAnnualReturn: numberValue(event.target.value) })} /></Field>
              <Field label="Planned monthly"><input type="number" className={`${INPUT} font-mono`} value={child.plannedMonthlyContribution} onChange={event => update(child.id, { plannedMonthlyContribution: numberValue(event.target.value) })} /></Field>
              <Field label="State deduction limit"><input type="number" className={`${INPUT} font-mono`} value={child.stateDeductionLimit} onChange={event => update(child.id, { stateDeductionLimit: numberValue(event.target.value) })} /></Field>
              <Field label="Record contribution" className="col-span-2"><div className="flex gap-2"><input type="number" className={`${INPUT} font-mono`} value={contributions[child.id] ?? ''} onChange={event => setContributions(current => ({ ...current, [child.id]: event.target.value }))} /><button type="button" onClick={() => recordContribution(child)} className="rounded-md border border-border px-3 text-sm text-primary">Record</button></div></Field>
            </div>
            {result && <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric label="Required monthly" value={formatCurrency(result.requiredMonthlyContribution)} /><Metric label="Monthly shortfall" value={formatCurrency(result.monthlyShortfall)} tone={result.monthlyShortfall > 0 ? 'warning' : 'positive'} /><Metric label="Contributed this year" value={formatCurrency(result.contributedThisYear)} tone="positive" /><Metric label="Deduction room" value={formatCurrency(result.stateDeductionRemaining)} /></div>}
            {result && <p className="mt-3 text-xs text-foreground-muted">{result.glidePath.guidance} Five-year gift elections and 529-to-Roth eligibility require tax-adviser review.</p>}
          </Panel>
        );
      })}
      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}

type UtilityResponse = {
  profile: UtilitiesProfile;
  analysis: { trailing12Cost: number; byType: Array<{ type: string; latestRate: number; usageChangePercent: number; rateChangePercent: number; trailing12Cost: number }> };
  solar: { upfrontCost: number; paybackYear: number | null; lifetimeSavings: number; currentElectricRate: number };
  suggestions: UtilityBill[];
};

export function UtilitiesPlannerPage() {
  const state = useSection<UtilitiesProfile, UtilityResponse>('utilities', {
    bills: [],
    solar: { enabled: false, systemCost: 0, incentives: 0, annualProductionKwh: 0, degradationRate: 0.5, electricRateInflation: 3, annualMaintenance: 0, analysisYears: 25 },
  });
  const [tab, setTab] = useState<'usage' | 'solar'>('usage');
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading utility history…</div>;
  const addBill = (bill?: UtilityBill) => state.change({ ...state.profile, bills: [...state.profile.bills, bill ?? { id: uid(), date: today(), type: 'electric', provider: '', usage: 0, unit: 'kWh', totalCost: 0, receiptId: null, transactionGuid: null }] });
  const updateBill = (id: string, patch: Partial<UtilityBill>) => state.change({ ...state.profile, bills: state.profile.bills.map(bill => bill.id === id ? { ...bill, ...patch } : bill) });
  const updateSolar = (patch: Partial<UtilitiesProfile['solar']>) => state.change({ ...state.profile, solar: { ...state.profile.solar, ...patch } });
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader title="Utilities & Solar" subtitle="Separate usage changes from rate increases and test solar against actual household bills." actions={<button type="button" onClick={() => addBill()} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">Add bill</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'usage', label: 'Usage & rates' }, { value: 'solar', label: 'Solar scenario' }]} />
      {tab === 'usage' && <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4"><Metric label="Trailing 12-month cost" value={formatCurrency(state.response?.analysis.trailing12Cost ?? 0)} />{state.response?.analysis.byType.map(row => <Metric key={row.type} label={`${row.type} unit rate`} value={`$${row.latestRate.toFixed(2)}`} tone={row.rateChangePercent > 15 ? 'warning' : undefined} />)}</div>
        {(state.response?.suggestions.length ?? 0) > 0 && <Panel title="Bills found in receipt OCR" description="Review before importing; the source receipt remains attached as evidence."><div className="space-y-2">{state.response?.suggestions.map(bill => <div key={bill.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 text-sm"><span>{bill.date} · {bill.provider} · <span className="font-mono">{bill.usage} {bill.unit} / {formatCurrency(bill.totalCost)}</span></span><button type="button" onClick={() => addBill(bill)} className="text-primary">Import</button></div>)}</div></Panel>}
        <Panel title="Utility bills" description="Rate and usage changes are calculated independently.">{state.profile.bills.length === 0 ? <Empty>Add a bill manually or import one from receipt OCR.</Empty> : <div className="space-y-2">{state.profile.bills.slice().sort((a, b) => b.date.localeCompare(a.date)).map(bill => <div key={bill.id} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 md:grid-cols-[140px_130px_1fr_140px_120px_140px_auto]"><input type="date" className={`${INPUT} font-mono`} value={bill.date} onChange={event => updateBill(bill.id, { date: event.target.value })} /><select className={INPUT} value={bill.type} onChange={event => { const type = event.target.value as UtilityBill['type']; updateBill(bill.id, { type, unit: type === 'electric' ? 'kWh' : type === 'gas' ? 'therms' : 'gallons' }); }}><option>electric</option><option>gas</option><option>water</option></select><input className={INPUT} placeholder="Provider" value={bill.provider} onChange={event => updateBill(bill.id, { provider: event.target.value })} /><input type="number" className={`${INPUT} font-mono`} value={bill.usage} onChange={event => updateBill(bill.id, { usage: numberValue(event.target.value) })} /><span className="py-2 text-xs text-foreground-muted">{bill.unit}</span><input type="number" className={`${INPUT} font-mono`} value={bill.totalCost} onChange={event => updateBill(bill.id, { totalCost: numberValue(event.target.value) })} /><button type="button" onClick={() => state.change({ ...state.profile, bills: state.profile.bills.filter(item => item.id !== bill.id) })} className="text-negative">×</button></div>)}</div>}</Panel>
      </>}
      {tab === 'solar' && <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4"><Metric label="Net upfront cost" value={formatCurrency(state.response?.solar.upfrontCost ?? 0)} /><Metric label="Current electric rate" value={`$${(state.response?.solar.currentElectricRate ?? 0).toFixed(2)}/kWh`} /><Metric label="Simple payback" value={state.response?.solar.paybackYear ? `${state.response.solar.paybackYear} years` : 'Not reached'} tone={state.response?.solar.paybackYear ? 'positive' : 'warning'} /><Metric label="Lifetime net savings" value={formatCurrency(state.response?.solar.lifetimeSavings ?? 0)} tone={(state.response?.solar.lifetimeSavings ?? 0) >= 0 ? 'positive' : 'negative'} /></div>
        <Panel title="Solar capital scenario" description="Uses entered production and actual latest electric rate; this is a planning scenario, not a contractor quote."><div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={state.profile.solar.enabled} onChange={event => updateSolar({ enabled: event.target.checked })} /> Enable scenario</label>{([['System cost','systemCost'],['Incentives','incentives'],['Annual production kWh','annualProductionKwh'],['Degradation %','degradationRate'],['Electric inflation %','electricRateInflation'],['Annual maintenance','annualMaintenance'],['Analysis years','analysisYears']] as const).map(([label, key]) => <Field key={key} label={label}><input type="number" step="0.1" className={`${INPUT} font-mono`} value={state.profile.solar[key]} onChange={event => updateSolar({ [key]: numberValue(event.target.value) })} /></Field>)}</div></Panel>
      </>}
      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}

type AccountOption = { guid: string; fullname: string; name: string; type: string };
type FamilyResponse = { profile: FamilyBankingProfile; children: Array<{ child: FamilyBankChild; balance: number; pendingCount: number; pendingAmount: number; goalRemaining: number; goalProgressPercent: number; allowanceDue: boolean }> };

export function FamilyBankingPage() {
  const state = useSection<FamilyBankingProfile, FamilyResponse>('family_banking', { children: [] });
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [entryText, setEntryText] = useState<Record<string, string>>({});
  const [entryAmount, setEntryAmount] = useState<Record<string, string>>({});
  useEffect(() => { fetch('/api/accounts?flat=true&noBalances=true').then(result => result.json()).then(json => setAccounts(Array.isArray(json) ? json : json.accounts ?? [])).catch(() => undefined); }, []);
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading family banking…</div>;
  const update = (id: string, patch: Partial<FamilyBankChild>) => state.change({ children: state.profile.children.map(child => child.id === id ? { ...child, ...patch } : child) });
  const addChild = () => state.change({ children: [...state.profile.children, { id: uid(), name: 'New child', liabilityAccountGuid: '', allowanceAmount: 5, allowanceCadence: 'weekly', nextAllowanceDate: today(), parentMatchPercent: 0, savingsGoal: 100, entries: [] }] });
  const addEntry = (child: FamilyBankChild, kind: FamilyBankEntryKind, approved: boolean) => {
    const raw = numberValue(entryAmount[child.id] ?? '');
    if (raw <= 0 || !(entryText[child.id] ?? '').trim()) return;
    const amount = kind === 'spend' ? -raw : raw;
    const entries = [...child.entries, { id: uid(), date: today(), description: entryText[child.id], amount, kind, approved, transactionGuid: null }];
    if (kind === 'deposit' && child.parentMatchPercent > 0) {
      entries.push({
        id: uid(),
        date: today(),
        description: `${child.parentMatchPercent}% parent savings match`,
        amount: raw * child.parentMatchPercent / 100,
        kind: 'match',
        approved: true,
        transactionGuid: null,
      });
    }
    update(child.id, { entries });
    setEntryText(current => ({ ...current, [child.id]: '' })); setEntryAmount(current => ({ ...current, [child.id]: '' }));
  };
  const advanceAllowance = (child: FamilyBankChild) => {
    const next = new Date(`${child.nextAllowanceDate}T12:00:00Z`);
    if (child.allowanceCadence === 'weekly') next.setUTCDate(next.getUTCDate() + 7); else next.setUTCMonth(next.getUTCMonth() + 1);
    update(child.id, { entries: [...child.entries, { id: uid(), date: today(), description: 'Scheduled allowance', amount: child.allowanceAmount, kind: 'allowance', approved: true, transactionGuid: null }], nextAllowanceDate: next.toISOString().slice(0, 10) });
  };
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader title="Family Banking" subtitle="Liability-backed child balances, allowances, chores, savings goals, and parent approvals." actions={<button type="button" onClick={addChild} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">Add child</button>} />
      {state.profile.children.length === 0 ? <Empty>Add a child and link a liability account to start an honest family ledger.</Empty> : state.profile.children.map(child => {
        const result = state.response?.children.find(item => item.child.id === child.id);
        return <Panel key={child.id} title={child.name} description={child.liabilityAccountGuid ? 'Backed by a linked liability account' : 'Link a liability account before treating this balance as funded'} action={<div className="flex gap-3"><a href={`/planning/family-banking/${child.id}`} className="text-xs text-primary">Kid view</a><button type="button" onClick={() => state.change({ children: state.profile.children.filter(item => item.id !== child.id) })} className="text-xs text-negative">Remove</button></div>}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4"><Metric label="Owed balance" value={formatCurrency(result?.balance ?? 0)} tone="positive" /><Metric label="Savings goal remaining" value={formatCurrency(result?.goalRemaining ?? child.savingsGoal)} /><Metric label="Goal progress" value={`${result?.goalProgressPercent ?? 0}%`} /><Metric label="Pending approval" value={String(result?.pendingCount ?? 0)} tone={(result?.pendingCount ?? 0) > 0 ? 'warning' : undefined} /></div>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Name"><input className={INPUT} value={child.name} onChange={event => update(child.id, { name: event.target.value })} /></Field>
            <Field label="Liability account"><select className={INPUT} value={child.liabilityAccountGuid} onChange={event => update(child.id, { liabilityAccountGuid: event.target.value })}><option value="">Select liability account</option>{accounts.filter(account => account.type === 'LIABILITY').map(account => <option key={account.guid} value={account.guid}>{account.fullname || account.name}</option>)}</select></Field>
            <Field label="Allowance"><input type="number" className={`${INPUT} font-mono`} value={child.allowanceAmount} onChange={event => update(child.id, { allowanceAmount: numberValue(event.target.value) })} /></Field>
            <Field label="Cadence"><select className={INPUT} value={child.allowanceCadence} onChange={event => update(child.id, { allowanceCadence: event.target.value as FamilyBankChild['allowanceCadence'] })}><option>weekly</option><option>monthly</option></select></Field>
            <Field label="Next allowance"><input type="date" className={`${INPUT} font-mono`} value={child.nextAllowanceDate} onChange={event => update(child.id, { nextAllowanceDate: event.target.value })} /></Field>
            <Field label="Parent match %"><input type="number" className={`${INPUT} font-mono`} value={child.parentMatchPercent} onChange={event => update(child.id, { parentMatchPercent: numberValue(event.target.value) })} /></Field>
            <Field label="Savings goal"><input type="number" className={`${INPUT} font-mono`} value={child.savingsGoal} onChange={event => update(child.id, { savingsGoal: numberValue(event.target.value) })} /></Field>
            <button type="button" onClick={() => advanceAllowance(child)} className="self-end rounded-md border border-border px-3 py-2 text-sm text-primary">Record allowance</button>
          </div>
          <div className="mt-4 grid grid-cols-[1fr_140px] gap-2"><input className={INPUT} placeholder="Chore, deposit, or purchase" value={entryText[child.id] ?? ''} onChange={event => setEntryText(current => ({ ...current, [child.id]: event.target.value }))} /><input type="number" className={`${INPUT} font-mono`} placeholder="Amount" value={entryAmount[child.id] ?? ''} onChange={event => setEntryAmount(current => ({ ...current, [child.id]: event.target.value }))} /></div>
          <div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => addEntry(child, 'chore', false)} className="rounded-md border border-border px-3 py-2 text-xs text-primary">Submit chore</button><button type="button" onClick={() => addEntry(child, 'deposit', true)} className="rounded-md border border-border px-3 py-2 text-xs text-primary">Record deposit</button><button type="button" onClick={() => addEntry(child, 'spend', true)} className="rounded-md border border-border px-3 py-2 text-xs text-primary">Record spending</button></div>
          {child.entries.length > 0 && <div className="mt-4 space-y-1">{child.entries.slice().reverse().slice(0, 30).map(entry => <div key={entry.id} className="flex items-center justify-between border-t border-border py-2 text-sm"><span>{entry.date} · {entry.description} <span className="text-xs text-foreground-muted">({entry.kind})</span></span><div className="flex items-center gap-3"><span className={`font-mono ${entry.amount >= 0 ? 'text-positive' : 'text-negative'}`} style={TNUM}>{formatCurrency(entry.amount)}</span>{!entry.approved && <button type="button" onClick={() => update(child.id, { entries: child.entries.map(item => item.id === entry.id ? { ...item, approved: true } : item) })} className="text-xs text-primary">Approve</button>}</div></div>)}</div>}
        </Panel>;
      })}
      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}

export function FamilyBankingChildView({ childId }: { childId: string }) {
  const [result, setResult] = useState<FamilyResponse['children'][number] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch(`/api/resilience/family-banking/${encodeURIComponent(childId)}`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Ledger unavailable')))
      .then(setResult)
      .finally(() => setLoading(false));
  }, [childId]);
  if (loading) return <div className="p-6 text-sm text-foreground-muted">Loading family ledger…</div>;
  if (!result) return <div className="p-6 text-sm text-negative">This family ledger is unavailable.</div>;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <PageHeader title={`${result.child.name}'s Money`} subtitle="A read-only view of approved family ledger activity and savings progress." />
      <div className="grid grid-cols-2 gap-3"><Metric label="Your balance" value={formatCurrency(result.balance)} tone="positive" /><Metric label="Goal progress" value={`${result.goalProgressPercent}%`} /></div>
      <Panel title="Approved activity" description="Pending chores remain private until a parent approves them.">
        {result.child.entries.length === 0 ? <Empty>No approved activity yet.</Empty> : <div className="space-y-1">{result.child.entries.slice().reverse().map(entry => <div key={entry.id} className="flex justify-between border-t border-border py-3 text-sm"><span>{entry.date} · {entry.description}</span><span className={`font-mono ${entry.amount >= 0 ? 'text-positive' : 'text-negative'}`}>{formatCurrency(entry.amount)}</span></div>)}</div>}
      </Panel>
    </div>
  );
}

type TripResult = { trip: TripPlan; spent: number; remainingBudget: number; fundingGap: number; requiredMonthlySavings: number; status: string };
type TripSuggestion = { tripId: string; transactionGuid: string; date: string; description: string; amount: number };
type TripsResponse = { profile: TripsProfile; trips: TripResult[]; suggestions: TripSuggestion[] };

export function TripsPlannerPage() {
  const state = useSection<TripsProfile, TripsResponse>('trips', { trips: [] });
  const [expenseText, setExpenseText] = useState<Record<string, string>>({});
  const [expenseAmount, setExpenseAmount] = useState<Record<string, string>>({});
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading trip plans…</div>;
  const update = (id: string, patch: Partial<TripPlan>) => state.change({ trips: state.profile.trips.map(trip => trip.id === id ? { ...trip, ...patch } : trip) });
  const addTrip = () => { const start = new Date(); start.setUTCMonth(start.getUTCMonth() + 6); const end = new Date(start); end.setUTCDate(end.getUTCDate() + 7); state.change({ trips: [...state.profile.trips, { id: uid(), name: 'New trip', destination: '', startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), budget: 2_000, savingsTarget: 2_000, fundedAmount: 0, tagId: null, tagName: 'vacation', current: false, expenses: [] }] }); };
  const addExpense = (trip: TripPlan, suggestion?: TripSuggestion) => {
    const amount = suggestion?.amount ?? numberValue(expenseAmount[trip.id] ?? '');
    const description = suggestion?.description ?? expenseText[trip.id] ?? '';
    if (amount <= 0 || !description.trim()) return;
    update(trip.id, { expenses: [...trip.expenses, { id: uid(), date: suggestion?.date ?? today(), description, amount, transactionGuid: suggestion?.transactionGuid ?? null }] });
    setExpenseText(current => ({ ...current, [trip.id]: '' })); setExpenseAmount(current => ({ ...current, [trip.id]: '' }));
  };
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader title="Trip & Vacation Budgets" subtitle="Date-ranged envelopes with savings targets, transaction suggestions, live spending, and plan-versus-actual." actions={<button type="button" onClick={addTrip} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">Plan trip</button>} />
      {state.profile.trips.length === 0 ? <Empty>Plan a trip to create a funding target and date-range transaction review.</Empty> : state.profile.trips.map(trip => {
        const result = state.response?.trips.find(item => item.trip.id === trip.id);
        const suggestions = state.response?.suggestions.filter(item => item.tripId === trip.id) ?? [];
        return <Panel key={trip.id} title={trip.name} description={`${result?.status ?? 'planning'} · ${trip.startDate} through ${trip.endDate}`} action={<button type="button" onClick={() => state.change({ trips: state.profile.trips.filter(item => item.id !== trip.id) })} className="text-xs text-negative">Remove</button>}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric label="Budget" value={formatCurrency(trip.budget)} /><Metric label="Spent" value={formatCurrency(result?.spent ?? 0)} /><Metric label="Remaining" value={formatCurrency(result?.remainingBudget ?? trip.budget)} tone={(result?.remainingBudget ?? 0) < 0 ? 'negative' : 'positive'} /><Metric label="Monthly savings needed" value={formatCurrency(result?.requiredMonthlySavings ?? 0)} tone={(result?.fundingGap ?? 0) > 0 ? 'warning' : 'positive'} /></div>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4"><Field label="Trip"><input className={INPUT} value={trip.name} onChange={event => update(trip.id, { name: event.target.value })} /></Field><Field label="Destination"><input className={INPUT} value={trip.destination} onChange={event => update(trip.id, { destination: event.target.value })} /></Field><Field label="Start"><input type="date" className={`${INPUT} font-mono`} value={trip.startDate} onChange={event => update(trip.id, { startDate: event.target.value })} /></Field><Field label="End"><input type="date" className={`${INPUT} font-mono`} value={trip.endDate} onChange={event => update(trip.id, { endDate: event.target.value })} /></Field><Field label="Budget"><input type="number" className={`${INPUT} font-mono`} value={trip.budget} onChange={event => update(trip.id, { budget: numberValue(event.target.value) })} /></Field><Field label="Savings target"><input type="number" className={`${INPUT} font-mono`} value={trip.savingsTarget} onChange={event => update(trip.id, { savingsTarget: numberValue(event.target.value) })} /></Field><Field label="Already funded"><input type="number" className={`${INPUT} font-mono`} value={trip.fundedAmount} onChange={event => update(trip.id, { fundedAmount: numberValue(event.target.value) })} /></Field><Field label="Transaction tag"><input className={INPUT} placeholder="vacation" value={trip.tagName ?? ''} onChange={event => update(trip.id, { tagName: event.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || null })} /></Field><label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={trip.current} onChange={event => { state.change({ trips: state.profile.trips.map(item => ({ ...item, current: item.id === trip.id ? event.target.checked : false })) }); }} /> Current trip for Quick Add</label></div>
          {suggestions.length > 0 && <div className="mt-4 rounded-md border border-warning/40 p-3"><p className="mb-2 text-xs font-semibold uppercase tracking-wider text-warning">Suggested date-range transactions</p>{suggestions.slice(0, 20).map(item => <div key={item.transactionGuid} className="flex items-center justify-between border-t border-border py-2 text-sm"><span>{item.date} · {item.description} · <span className="font-mono">{formatCurrency(item.amount)}</span></span><button type="button" onClick={() => addExpense(trip, item)} className="text-primary">Add to trip</button></div>)}</div>}
          <div className="mt-4 grid grid-cols-[1fr_140px_auto] gap-2"><input className={INPUT} placeholder="Expense description" value={expenseText[trip.id] ?? ''} onChange={event => setExpenseText(current => ({ ...current, [trip.id]: event.target.value }))} /><input type="number" className={`${INPUT} font-mono`} value={expenseAmount[trip.id] ?? ''} onChange={event => setExpenseAmount(current => ({ ...current, [trip.id]: event.target.value }))} /><button type="button" onClick={() => addExpense(trip)} className="rounded-md border border-border px-3 text-sm text-primary">Add</button></div>
          {trip.expenses.length > 0 && <div className="mt-3 space-y-1">{trip.expenses.slice().reverse().map(expense => <div key={expense.id} className="flex justify-between border-t border-border py-2 text-sm"><span>{expense.date} · {expense.description}{expense.transactionGuid && <span className="ml-2 text-xs text-positive">Linked</span>}</span><span className="font-mono">{formatCurrency(expense.amount)}</span></div>)}</div>}
        </Panel>;
      })}
      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}

type VehicleResult = { vehicle: VehicleTcoAsset; trailing12FuelCost: number; trailing12Miles: number; annualDepreciation: number; annualTotalCost: number; monthlyRunRate: number; costPerMile: number; keepAndRepairCost: number; replaceCost: number; recommendedDecision: 'repair' | 'replace'; decisionSavings: number };
type MileageVehicle = { id: string; name: string; year?: number | null; make?: string | null; model?: string | null };
type VehicleResponse = { profile: VehicleTcoProfile; vehicles: VehicleResult[]; mileageVehicles: MileageVehicle[] };

export function VehicleTcoPage() {
  const state = useSection<VehicleTcoProfile, VehicleResponse>('vehicle_tco', { vehicles: [] });
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading vehicle costs…</div>;
  const update = (id: string, patch: Partial<VehicleTcoAsset>) => state.change({ vehicles: state.profile.vehicles.map(vehicle => vehicle.id === id ? { ...vehicle, ...patch } : vehicle) });
  const addVehicle = () => state.change({ vehicles: [...state.profile.vehicles, { id: uid(), mileageVehicleId: state.response?.mileageVehicles[0]?.id ?? null, name: state.response?.mileageVehicles[0]?.name ?? 'New vehicle', purchaseDate: today(), purchasePrice: 0, currentValue: 0, annualInsurance: 0, annualRegistration: 0, annualMaintenance: 0, annualOther: 0, repairCost: 0, repairExtendsYears: 3, replacementVehicleCost: 0, replacementAnnualOperatingCost: 0 }] });
  const totals = state.response?.vehicles ?? [];
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader title="Vehicle Total Cost of Ownership" subtitle="Fuel, insurance, registration, maintenance, depreciation, mileage, and repair-versus-replace evidence." actions={<button type="button" onClick={addVehicle} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">Add vehicle</button>} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Metric label="Fleet annual cost" value={formatCurrency(totals.reduce((sum, row) => sum + row.annualTotalCost, 0))} /><Metric label="Fleet monthly run rate" value={formatCurrency(totals.reduce((sum, row) => sum + row.monthlyRunRate, 0))} /><Metric label="Tracked miles" value={totals.reduce((sum, row) => sum + row.trailing12Miles, 0).toFixed(1)} /></div>
      {state.profile.vehicles.length === 0 ? <Empty>Add a vehicle and link the Mileage Log to pull fuel and mileage evidence automatically.</Empty> : state.profile.vehicles.map(vehicle => {
        const result = state.response?.vehicles.find(item => item.vehicle.id === vehicle.id);
        return <Panel key={vehicle.id} title={vehicle.name} description={result ? `${formatCurrency(result.annualTotalCost)}/year · $${result.costPerMile.toFixed(2)}/mile` : undefined} action={<button type="button" onClick={() => state.change({ vehicles: state.profile.vehicles.filter(item => item.id !== vehicle.id) })} className="text-xs text-negative">Remove</button>}>
          {result && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric label="Fuel, trailing 12m" value={formatCurrency(result.trailing12FuelCost)} /><Metric label="Annual depreciation" value={formatCurrency(result.annualDepreciation)} /><Metric label="Repair scenario" value={formatCurrency(result.keepAndRepairCost)} tone={result.recommendedDecision === 'repair' ? 'positive' : undefined} /><Metric label="Replace scenario" value={formatCurrency(result.replaceCost)} tone={result.recommendedDecision === 'replace' ? 'positive' : undefined} /></div>}
          {result && <p className="mt-3 rounded-md border border-primary/30 bg-primary-light p-3 text-sm text-foreground">Entered assumptions favor <strong className="text-primary">{result.recommendedDecision}</strong> by <span className="font-mono">{formatCurrency(result.decisionSavings)}</span> over {vehicle.repairExtendsYears} years.</p>}
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Vehicle"><input className={INPUT} value={vehicle.name} onChange={event => update(vehicle.id, { name: event.target.value })} /></Field>
            <Field label="Mileage/Fuel link"><select className={INPUT} value={vehicle.mileageVehicleId ?? ''} onChange={event => { const linked = state.response?.mileageVehicles.find(item => item.id === event.target.value); update(vehicle.id, { mileageVehicleId: event.target.value || null, name: vehicle.name === 'New vehicle' && linked ? linked.name : vehicle.name }); }}><option value="">Unlinked</option>{state.response?.mileageVehicles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            <Field label="Purchase date"><input type="date" className={`${INPUT} font-mono`} value={vehicle.purchaseDate} onChange={event => update(vehicle.id, { purchaseDate: event.target.value })} /></Field>
            {([['Purchase price','purchasePrice'],['Current value','currentValue'],['Annual insurance override','annualInsurance'],['Annual registration','annualRegistration'],['Annual maintenance','annualMaintenance'],['Annual other','annualOther'],['Repair estimate','repairCost'],['Repair adds years','repairExtendsYears'],['Replacement price','replacementVehicleCost'],['Replacement annual operating','replacementAnnualOperatingCost']] as const).map(([label, key]) => <Field key={key} label={label}><input type="number" className={`${INPUT} font-mono`} value={vehicle[key]} onChange={event => update(vehicle.id, { [key]: numberValue(event.target.value) })} /></Field>)}
          </div>
        </Panel>;
      })}
      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}
