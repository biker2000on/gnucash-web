'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { calculateGivingPlan } from '@/lib/resilience/giving-core';
import type {
  Donation,
  GivingProfile,
  GivingSettings,
  PlanningFilingStatus,
} from '@/lib/resilience/types';
import { Empty, Field, FieldGrid, INPUT, Metric, Panel, RecordCard, SaveBar, TNUM } from './ui';
import { LinkedDocumentsPanel } from '@/components/documents/LinkedDocumentsPanel';
import { extractErrorMessage } from '@/lib/api-error';

const GIVING_DOCUMENT_ROLES = [
  { value: 'acknowledgment', label: 'Acknowledgment' },
  { value: 'appraisal', label: 'Qualified appraisal' },
  { value: 'form_8283', label: 'Form 8283' },
  { value: 'noncash_receipt', label: 'Noncash receipt' },
  { value: 'qcd_confirmation', label: 'QCD confirmation' },
] as const;

const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const numberValue = (value: string) => Number(value) || 0;
const optionalNumber = (value: string) => value.trim() === '' ? null : Number(value) || 0;

type GivingPlan = ReturnType<typeof calculateGivingPlan>;
type GivingResponse = {
  profile: GivingProfile;
  plan: GivingPlan;
  /** Household identity context; absent on responses from an older server. */
  household?: {
    filingStatus: PlanningFilingStatus | null;
    effectiveFilingStatus: PlanningFilingStatus;
    filingStatusInherited: boolean;
  };
};

const FILING_STATUS_LABELS: Record<PlanningFilingStatus, string> = {
  single: 'Single',
  married_joint: 'Married filing jointly',
};

const SETTINGS_LINK = 'text-primary underline-offset-2 hover:underline';

const DEFAULT_SETTINGS: GivingSettings = {
  // null = inherit the household filing status configured in Settings.
  filingStatus: null,
  marginalRatePct: 22,
  stateRatePct: 0,
  agiEstimate: null,
  birthYear: null,
  spouseBirthYear: null,
  plannedAnnualGiving: 0,
  standardDeductionOverride: null,
  otherItemizedAnnual: 0,
};

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
    if (!result.ok) throw new Error(extractErrorMessage(json, 'Request failed'));
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
      if (!result.ok) throw new Error(extractErrorMessage(json, 'Save failed'));
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

function DonationFlags(props: { donation: GivingPlan['donations'][number] | undefined }) {
  if (!props.donation) return null;
  const flags: Array<{ label: string; className: string }> = [];
  if (props.donation.needsAcknowledgment) flags.push({ label: 'Needs acknowledgment letter', className: 'text-warning border-warning/40' });
  if (props.donation.needsForm8283) flags.push({ label: 'Form 8283 year', className: 'text-foreground-secondary border-border' });
  if (props.donation.needsAppraisal) flags.push({ label: 'Qualified appraisal required', className: 'text-negative border-negative/40' });
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {flags.map(flag => (
        <span key={flag.label} className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${flag.className}`}>
          {flag.label}
        </span>
      ))}
    </div>
  );
}

function StrategyCard(props: {
  title: string;
  description: string;
  year1: number;
  year2: number;
  total: number;
  recommended: boolean;
}) {
  return (
    <div className={`rounded-lg border p-4 ${props.recommended ? 'border-primary bg-primary-light' : 'border-border bg-background-secondary/30'}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>
        {props.recommended && <span className="rounded border border-primary/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">Recommended</span>}
      </div>
      <p className="mt-1 text-xs text-foreground-muted">{props.description}</p>
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between"><dt className="text-foreground-secondary">Year 1 deduction</dt><dd className="font-mono" style={TNUM}>{formatCurrency(props.year1)}</dd></div>
        <div className="flex justify-between"><dt className="text-foreground-secondary">Year 2 deduction</dt><dd className="font-mono" style={TNUM}>{formatCurrency(props.year2)}</dd></div>
        <div className="flex justify-between border-t border-border pt-1"><dt className="font-semibold text-foreground">Two-year total</dt><dd className="font-mono font-semibold" style={TNUM}>{formatCurrency(props.total)}</dd></div>
      </dl>
    </div>
  );
}

export function GivingPage() {
  const state = useSection<GivingProfile, GivingResponse>('giving', { donations: [], settings: DEFAULT_SETTINGS });
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading charitable giving…</div>;
  const plan = state.response?.plan;
  const household = state.response?.household;
  const updateDonation = (id: string, patch: Partial<Donation>) =>
    state.change({ ...state.profile, donations: state.profile.donations.map(donation => donation.id === id ? { ...donation, ...patch } : donation) });
  const updateSettings = (patch: Partial<GivingSettings>) =>
    state.change({ ...state.profile, settings: { ...state.profile.settings, ...patch } });
  const addDonation = () => state.change({
    ...state.profile,
    donations: [...state.profile.donations, { id: uid(), date: today(), charity: '', kind: 'cash', amount: 0, description: null, acknowledged: false, documentRef: null }],
  });
  const qcdStatus = plan
    ? plan.qcd.eligible
      ? `${formatCurrency(plan.qcd.remainingCapacity)} room`
      : 'Not eligible'
    : '—';
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Charitable Giving & Bunching"
        subtitle="Donation log with substantiation checks, charity mileage, QCD eligibility, and a two-year deduction bunching comparison."
        actions={<button type="button" onClick={addDonation} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add donation</button>}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Metric label={`${plan?.currentYear ?? new Date().getUTCFullYear()} giving`} value={formatCurrency(plan?.currentYearTotal ?? 0)} tone="positive" />
        <Metric label="Substantiation issues" value={plan?.substantiationIssueCount ?? 0} tone={(plan?.substantiationIssueCount ?? 0) > 0 ? 'warning' : 'positive'} />
        <Metric label="Bunching tax savings" value={formatCurrency(plan?.bunching.estimatedTaxSavings ?? 0)} tone={plan?.bunching.recommendBunching ? 'positive' : undefined} />
        <Metric label="QCD status" value={qcdStatus} tone={plan?.qcd.eligible ? 'positive' : undefined} />
      </div>

      <Panel title="Donations" description="Cash, noncash (at fair market value), and qualified charitable distributions. Flags come from IRS substantiation thresholds.">
        {state.profile.donations.length === 0 ? <Empty>Add a donation to start tracking substantiation and year totals.</Empty> : (
          <div className="space-y-2">
            {state.profile.donations.slice().sort((a, b) => b.date.localeCompare(a.date)).map(donation => {
              const row = plan?.donations.find(item => item.id === donation.id);
              return (
                <RecordCard
                  key={donation.id}
                  title={donation.charity || 'New donation'}
                  removeLabel="Remove donation"
                  onRemove={() => state.change({ ...state.profile, donations: state.profile.donations.filter(item => item.id !== donation.id) })}
                >
                  <FieldGrid>
                    <Field label="Date"><input type="date" className={`${INPUT} font-mono`} value={donation.date} onChange={event => updateDonation(donation.id, { date: event.target.value })} /></Field>
                    <Field label="Charity"><input className={INPUT} value={donation.charity} onChange={event => updateDonation(donation.id, { charity: event.target.value })} /></Field>
                    <Field label="Kind">
                      <select className={INPUT} value={donation.kind} onChange={event => updateDonation(donation.id, { kind: event.target.value as Donation['kind'] })}>
                        <option value="cash">Cash</option>
                        <option value="noncash">Noncash (FMV)</option>
                        <option value="qcd">QCD</option>
                      </select>
                    </Field>
                    <Field label="Amount"><input type="number" className={`${INPUT} font-mono`} value={donation.amount} onChange={event => updateDonation(donation.id, { amount: numberValue(event.target.value) })} /></Field>
                    <Field label="Description"><input className={INPUT} placeholder="What was donated" value={donation.description ?? ''} onChange={event => updateDonation(donation.id, { description: event.target.value || null })} /></Field>
                  </FieldGrid>
                  {donation.documentRef && (
                    <p className="rounded-md border border-border bg-background-tertiary/40 px-3 py-2 text-xs text-foreground-secondary">
                      Legacy document note (read only): <span className="text-foreground">{donation.documentRef}</span>. It was not converted into a document link automatically.
                    </p>
                  )}
                  {state.response?.profile.donations.some(saved => saved.id === donation.id) ? (
                    <LinkedDocumentsPanel
                      targetType="giving_donation"
                      targetId={donation.id}
                      roles={GIVING_DOCUMENT_ROLES}
                      readonly={state.dirty}
                      title="Donation substantiation"
                    />
                  ) : (
                    <p className="text-xs text-foreground-muted">Save this donation before attaching substantiation.</p>
                  )}
                  {state.dirty && state.response?.profile.donations.some(saved => saved.id === donation.id) && (
                    <p className="text-xs text-foreground-muted">Save donation changes to attach or unlink documents.</p>
                  )}
                  <label className="flex items-center gap-2 text-xs text-foreground-secondary">
                    <input type="checkbox" checked={donation.acknowledged} onChange={event => updateDonation(donation.id, { acknowledged: event.target.checked })} />
                    Acknowledgment letter on file
                  </label>
                  <DonationFlags donation={row} />
                </RecordCard>
              );
            })}
          </div>
        )}
        {plan && plan.yearTotals.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                  <th className="py-1 pr-4">Tax year</th>
                  <th className="py-1 pr-4 text-right">Cash</th>
                  <th className="py-1 pr-4 text-right">Noncash</th>
                  <th className="py-1 pr-4 text-right">QCD</th>
                  <th className="py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="font-mono" style={TNUM}>
                {plan.yearTotals.map(row => (
                  <tr key={row.taxYear} className="border-b border-border/50">
                    <td className="py-1 pr-4">{row.taxYear}{row.form8283Required ? ' · 8283' : ''}</td>
                    <td className="py-1 pr-4 text-right">{formatCurrency(row.cashTotal)}</td>
                    <td className="py-1 pr-4 text-right">{formatCurrency(row.noncashTotal)}</td>
                    <td className="py-1 pr-4 text-right">{formatCurrency(row.qcdTotal)}</td>
                    <td className="py-1 text-right">{formatCurrency(row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Bunching comparison" description="Two years of planned giving, given evenly versus bunched into year one with the standard deduction in year two.">
        {plan ? (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <StrategyCard
                title="Give evenly"
                description={`${formatCurrency(plan.bunching.plannedAnnualGiving)} donated each year.`}
                year1={plan.bunching.even.year1Deduction}
                year2={plan.bunching.even.year2Deduction}
                total={plan.bunching.even.totalDeductions}
                recommended={!plan.bunching.recommendBunching}
              />
              <StrategyCard
                title="Bunch into year 1"
                description={`${formatCurrency(plan.bunching.plannedAnnualGiving * 2)} donated in year one, standard deduction in year two.`}
                year1={plan.bunching.bunch.year1Deduction}
                year2={plan.bunching.bunch.year2Deduction}
                total={plan.bunching.bunch.totalDeductions}
                recommended={plan.bunching.recommendBunching}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric label="Standard deduction" value={formatCurrency(plan.bunching.standardDeduction)} />
              <Metric label="Incremental deduction" value={formatCurrency(plan.bunching.incrementalDeduction)} />
              <Metric label="Combined rate" value={`${plan.bunching.combinedRatePct.toFixed(1)}%`} />
              <Metric label="Estimated tax savings" value={formatCurrency(plan.bunching.estimatedTaxSavings)} tone={plan.bunching.recommendBunching ? 'positive' : undefined} />
            </div>
            <p className="mt-3 text-xs text-foreground-muted">
              {plan.bunching.formula}. Uses the {plan.bunching.taxYear} standard deduction for both years; charity mileage adds {formatCurrency(plan.charityMileageDeduction)} from {plan.charityMiles} logged charity miles. Planning estimate, not tax advice.
            </p>
          </>
        ) : <Empty>Save settings to compute the bunching comparison.</Empty>}
      </Panel>

      <Panel title="Settings" description="Planning inputs for the deduction comparison and QCD eligibility.">
        <FieldGrid>
          <Field label="Filing status">
            <select
              className={INPUT}
              value={state.profile.settings.filingStatus ?? ''}
              onChange={event => updateSettings({
                filingStatus: event.target.value === '' ? null : event.target.value as PlanningFilingStatus,
              })}
            >
              <option value="">
                {household?.filingStatus
                  ? `From household settings — ${FILING_STATUS_LABELS[household.filingStatus]}`
                  : `From household settings — ${FILING_STATUS_LABELS[household?.effectiveFilingStatus ?? 'married_joint']} (not set)`}
              </option>
              <option value="single">Single (override)</option>
              <option value="married_joint">Married filing jointly (override)</option>
            </select>
          </Field>
          <Field label="Marginal rate %"><input type="number" step="0.1" className={`${INPUT} font-mono`} value={state.profile.settings.marginalRatePct} onChange={event => updateSettings({ marginalRatePct: numberValue(event.target.value) })} /></Field>
          <Field label="State rate %"><input type="number" step="0.1" className={`${INPUT} font-mono`} value={state.profile.settings.stateRatePct ?? ''} onChange={event => updateSettings({ stateRatePct: optionalNumber(event.target.value) })} /></Field>
          <Field label="AGI estimate"><input type="number" className={`${INPUT} font-mono`} value={state.profile.settings.agiEstimate ?? ''} onChange={event => updateSettings({ agiEstimate: optionalNumber(event.target.value) })} /></Field>
          <Field label="Birth year"><input type="number" className={`${INPUT} font-mono`} value={state.profile.settings.birthYear ?? ''} onChange={event => updateSettings({ birthYear: optionalNumber(event.target.value) })} /></Field>
          <Field label="Spouse birth year"><input type="number" className={`${INPUT} font-mono`} value={state.profile.settings.spouseBirthYear ?? ''} onChange={event => updateSettings({ spouseBirthYear: optionalNumber(event.target.value) })} /></Field>
          <Field label="Planned annual giving"><input type="number" className={`${INPUT} font-mono`} value={state.profile.settings.plannedAnnualGiving} onChange={event => updateSettings({ plannedAnnualGiving: numberValue(event.target.value) })} /></Field>
          <Field label="Other itemized (SALT, interest)"><input type="number" className={`${INPUT} font-mono`} value={state.profile.settings.otherItemizedAnnual} onChange={event => updateSettings({ otherItemizedAnnual: numberValue(event.target.value) })} /></Field>
          <Field label="Standard deduction override"><input type="number" className={`${INPUT} font-mono`} value={state.profile.settings.standardDeductionOverride ?? ''} onChange={event => updateSettings({ standardDeductionOverride: optionalNumber(event.target.value) })} /></Field>
        </FieldGrid>
        {household && !household.filingStatus && (
          <p className="mt-3 text-xs text-foreground-muted">
            No household filing status is set, so this comparison uses{' '}
            {FILING_STATUS_LABELS[household.effectiveFilingStatus]}. Set it once in{' '}
            <Link href="/settings" className={SETTINGS_LINK}>Settings</Link> to share it across every pack.
          </p>
        )}
        {plan?.qcd.eligible && (
          <p className="mt-3 text-xs text-foreground-muted">
            QCD-eligible: up to {formatCurrency(plan.qcd.householdAnnualLimit)} per year can go directly from a traditional IRA to charity ({formatCurrency(plan.qcd.qcdThisYear)} used this year). Eligibility assumed once age 71 is reached by year end, since only birth years are on file.
          </p>
        )}
      </Panel>

      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}
