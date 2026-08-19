'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import { HOUSEHOLD_ROLE_LABELS, birthYearFromBirthday } from '@/lib/resilience/household';
import type { analyzeRetirementIncome } from '@/lib/resilience/retirement-income-core';
import type {
  HouseholdMember,
  HouseholdRole,
  PlanningFilingStatus,
  RetirementIncomeProfile,
  RetirementIncomeSettings,
  RetirementPerson,
} from '@/lib/resilience/types';
import { Empty, Field, FieldGrid, INPUT, Metric, Panel, RecordCard, SaveBar, TNUM } from './ui';
import { Abbr } from '@/components/ui/Abbr';
import { extractErrorMessage } from '@/lib/api-error';

const uid = () => crypto.randomUUID();
const numberValue = (value: string) => Number(value) || 0;

type RetirementAnalysis = ReturnType<typeof analyzeRetirementIncome>;
interface HouseholdContext {
  members: HouseholdMember[];
  filingStatus: PlanningFilingStatus | null;
  effectiveFilingStatus: PlanningFilingStatus;
  filingStatusInherited: boolean;
}
type RetirementResponse = {
  profile: RetirementIncomeProfile;
  analysis: RetirementAnalysis;
  household?: HouseholdContext;
};

const DEFAULT_SETTINGS: RetirementIncomeSettings = {
  // null = inherit the household filing status configured in Settings.
  filingStatus: null,
  annualSpending: 0,
  horizonAge: 90,
  colaPct: 2.5,
  realReturnPct: 4,
  sequencingPreference: 'taxable_first',
};

const FILING_STATUS_LABELS: Record<PlanningFilingStatus, string> = {
  single: 'Single',
  married_joint: 'Married filing jointly',
};

const SETTINGS_LINK = 'text-primary underline-offset-2 hover:underline';

/** "Cara Crawford (Spouse)" when named, else just the role label. */
function memberLabel(member: HouseholdMember): string {
  const role = HOUSEHOLD_ROLE_LABELS[member.role];
  return member.name ? `${member.name} (${role})` : role;
}

const SEQUENCING_LABELS: Record<RetirementIncomeSettings['sequencingPreference'], string> = {
  taxable_first: 'Taxable first (default)',
  traditional_first: 'Traditional first',
  proportional: 'Proportional blend',
};

const CLAIM_AGES = [62, 63, 64, 65, 66, 67, 68, 69, 70] as const;

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

/**
 * Identity fields for one person.
 *
 * Household members are the source of truth: picking one takes the name and
 * birthday from Settings and shows them read-only. Manual name/birth-year entry
 * stays available for a person who is not on the household roster, and for a
 * linked member whose birthday has not been recorded yet.
 */
function PersonIdentityFields(props: {
  person: RetirementPerson;
  members: HouseholdMember[];
  onChange: (patch: Partial<RetirementPerson>) => void;
}) {
  const { person, members } = props;
  const linked = members.find(member => member.role === person.memberRole) ?? null;
  const linkedBirthYear = birthYearFromBirthday(linked?.birthday);

  const selectMember = (value: string) => {
    if (value === '') {
      props.onChange({ memberRole: null });
      return;
    }
    const member = members.find(item => item.role === value);
    if (!member) return;
    // Snapshot name and birth year so the record still reads correctly if the
    // roster row is later renamed or removed; the roster wins while it exists.
    props.onChange({
      memberRole: member.role,
      name: member.name || HOUSEHOLD_ROLE_LABELS[member.role],
      birthYear: birthYearFromBirthday(member.birthday) ?? person.birthYear,
    });
  };

  return (
    <>
      <Field label="Household member">
        <select
          className={INPUT}
          aria-label="Household member"
          value={person.memberRole ?? ''}
          onChange={event => selectMember(event.target.value)}
        >
          <option value="">Not a household member — enter manually</option>
          {members.map(member => (
            <option key={member.role} value={member.role}>{memberLabel(member)}</option>
          ))}
        </select>
      </Field>
      {linked ? (
        <Field label="Birth year">
          {linkedBirthYear != null ? (
            <p className="rounded-md border border-transparent px-3 py-2.5 text-sm text-foreground">
              <span className="font-mono">{linkedBirthYear}</span>
              <span className="text-foreground-muted"> · born {linked.birthday} (household settings)</span>
            </p>
          ) : (
            <>
              <input
                type="number"
                min={1900}
                max={2100}
                className={`${INPUT} font-mono`}
                value={person.birthYear}
                onChange={event => props.onChange({ birthYear: numberValue(event.target.value) })}
              />
              <span className="mt-1 block text-xs text-foreground-muted">
                No birthday recorded for this member — add one in Settings to share it everywhere.
              </span>
            </>
          )}
        </Field>
      ) : (
        <>
          <Field label="Name (manual)">
            <input
              className={INPUT}
              placeholder="Name"
              value={person.name}
              onChange={event => props.onChange({ name: event.target.value })}
            />
          </Field>
          <Field label="Birth year (manual)">
            <input
              type="number"
              min={1900}
              max={2100}
              className={`${INPUT} font-mono`}
              value={person.birthYear}
              onChange={event => props.onChange({ birthYear: numberValue(event.target.value) })}
            />
          </Field>
        </>
      )}
    </>
  );
}

const TH = 'px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground-muted';
const TD = 'px-2 py-1.5 text-sm text-foreground';
const TD_NUM = `${TD} text-right font-mono`;

export function RetirementIncomePage() {
  const state = useSection<RetirementIncomeProfile, RetirementResponse>('retirement_income', {
    people: [],
    balances: { taxable: 0, traditional: 0, roth: 0, hsa: 0 },
    settings: DEFAULT_SETTINGS,
  });
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading retirement income plan…</div>;
  const analysis = state.response?.analysis;
  const sequencing = analysis?.sequencing ?? null;
  const irmaa = analysis?.irmaa ?? null;
  const household = state.response?.household;
  const members = household?.members ?? [];
  // Roles already taken by another row, so one member can't be picked twice.
  const takenRoles = (role: HouseholdRole | null | undefined) =>
    state.profile.people
      .map(person => person.memberRole)
      .filter((value): value is HouseholdRole => value != null && value !== role);

  const updatePerson = (id: string, patch: Partial<RetirementPerson>) =>
    state.change({ ...state.profile, people: state.profile.people.map(item => item.id === id ? { ...item, ...patch } : item) });
  const removePerson = (id: string) =>
    state.change({ ...state.profile, people: state.profile.people.filter(item => item.id !== id) });
  const addPerson = () => state.change({
    ...state.profile,
    people: [...state.profile.people, { id: uid(), memberRole: null, name: '', birthYear: 1965, pia: 0, annualEarnings: null, plannedClaimAge: 67 }],
  });
  const updateBalances = (patch: Partial<RetirementIncomeProfile['balances']>) =>
    state.change({ ...state.profile, balances: { ...state.profile.balances, ...patch } });
  const updateSettings = (patch: Partial<RetirementIncomeSettings>) =>
    state.change({ ...state.profile, settings: { ...state.profile.settings, ...patch } });

  const recommendedSummary = analysis && analysis.people.length > 0
    ? analysis.people.map(person => `${person.name || 'Person'}: ${person.recommendedLabel}`).join(' · ')
    : '—';
  const maxLifetimeDelta = analysis
    ? Math.max(0, ...analysis.people.map(person => person.lifetimeDelta))
    : 0;
  const firstRmdYear = analysis && analysis.rmd.length > 0
    ? Math.min(...analysis.rmd.map(row => row.firstRmdYear))
    : null;
  const bestVariant = sequencing?.variants.find(variant => variant.id === sequencing.bestVariantId) ?? null;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Retirement Income Sequencing"
        subtitle="Social Security claiming comparison with breakevens, withdrawal-order comparison via the drawdown engine, IRMAA cliff headroom, and RMD context."
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Metric label="Recommended claim" value={recommendedSummary} />
        <Metric
          label="Lifetime delta vs plan"
          value={formatCurrency(maxLifetimeDelta)}
          tone={maxLifetimeDelta > 0 ? 'warning' : 'positive'}
        />
        <Metric
          label="IRMAA headroom"
          value={irmaa?.headroomToNextTier != null ? formatCurrency(irmaa.headroomToNextTier) : '—'}
          tone={irmaa?.withinCliff ? 'negative' : undefined}
        />
        <Metric label="First RMD year" value={firstRmdYear ?? '—'} />
      </div>

      <Panel
        title="People"
        description="Up to two people, taken from your household members. Enter the monthly PIA from your SSA statement; with a PIA of 0 and annual earnings entered, the SSA formula estimates it from constant real earnings."
        action={state.profile.people.length < 2
          ? <button type="button" onClick={addPerson} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add person</button>
          : null}
      >
        {members.length === 0 && (
          <p className="mb-3 text-xs text-foreground-muted">
            No household members are configured yet. Add them (with birthdays) in{' '}
            <Link href="/settings" className={SETTINGS_LINK}>Settings</Link> and this page fills in
            names and birth years automatically. Until then, enter people manually below.
          </p>
        )}
        {state.profile.people.length === 0 ? <Empty>Add yourself (and a spouse) with birth year and monthly PIA to compare claiming ages.</Empty> : (
          <div className="space-y-2">
            {state.profile.people.map(person => {
              const row = analysis?.people.find(item => item.personId === person.id);
              const taken = takenRoles(person.memberRole);
              return (
                <RecordCard
                  key={person.id}
                  title={person.name || 'New person'}
                  removeLabel="Remove person"
                  onRemove={() => removePerson(person.id)}
                >
                  <FieldGrid>
                    <PersonIdentityFields
                      person={person}
                      members={members.filter(member => !taken.includes(member.role))}
                      onChange={patch => updatePerson(person.id, patch)}
                    />
                    <Field label="Monthly PIA at FRA"><input type="number" min={0} className={`${INPUT} font-mono`} value={person.pia} onChange={event => updatePerson(person.id, { pia: numberValue(event.target.value) })} /></Field>
                    <Field label="Annual earnings (if PIA 0)"><input type="number" min={0} className={`${INPUT} font-mono`} value={person.annualEarnings ?? ''} onChange={event => updatePerson(person.id, { annualEarnings: event.target.value === '' ? null : numberValue(event.target.value) })} /></Field>
                    <Field label="Planned claim age">
                      <select className={INPUT} value={person.plannedClaimAge} onChange={event => updatePerson(person.id, { plannedClaimAge: numberValue(event.target.value) })}>
                        {CLAIM_AGES.map(age => <option key={age} value={age}>{age}</option>)}
                      </select>
                    </Field>
                  </FieldGrid>
                  {row && row.piaSource !== 'missing' && (
                    <p className="text-xs text-foreground-muted">
                      FRA {row.fraLabel} · PIA {formatCurrency(row.pia)}/mo ({row.piaSource === 'estimated' ? 'estimated from earnings' : 'entered'}) · planned benefit {formatCurrency(row.plannedMonthlyBenefit)}/mo at {row.plannedClaimAge}.
                    </p>
                  )}
                  {row?.piaSource === 'missing' && (
                    <p className="text-xs text-warning">Enter a monthly PIA or annual earnings to compute this person&apos;s benefits.</p>
                  )}
                </RecordCard>
              );
            })}
          </div>
        )}
        {members.length > 0 && (
          <p className="mt-3 text-xs text-foreground-muted">
            Names and birthdays come from your household members —{' '}
            <Link href="/settings" className={SETTINGS_LINK}>change them in Settings</Link> and every
            planning pack follows. Only the Social Security and balance inputs live here.
          </p>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Balances" description="Household balances by tax bucket, in today's dollars.">
          <FieldGrid cols={2}>
            <Field label="Taxable"><input type="number" min={0} className={`${INPUT} font-mono`} value={state.profile.balances.taxable} onChange={event => updateBalances({ taxable: numberValue(event.target.value) })} /></Field>
            <Field label="Traditional (pre-tax)"><input type="number" min={0} className={`${INPUT} font-mono`} value={state.profile.balances.traditional} onChange={event => updateBalances({ traditional: numberValue(event.target.value) })} /></Field>
            <Field label="Roth"><input type="number" min={0} className={`${INPUT} font-mono`} value={state.profile.balances.roth} onChange={event => updateBalances({ roth: numberValue(event.target.value) })} /></Field>
            <Field label="HSA"><input type="number" min={0} className={`${INPUT} font-mono`} value={state.profile.balances.hsa} onChange={event => updateBalances({ hsa: numberValue(event.target.value) })} /></Field>
          </FieldGrid>
        </Panel>

        <Panel title="Settings" description="Filing status, spending, horizon, and return assumptions shared by every projection.">
          <FieldGrid cols={2}>
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
            <Field label="Annual spending"><input type="number" min={0} className={`${INPUT} font-mono`} value={state.profile.settings.annualSpending} onChange={event => updateSettings({ annualSpending: numberValue(event.target.value) })} /></Field>
            <Field label="Horizon age"><input type="number" min={70} max={110} className={`${INPUT} font-mono`} value={state.profile.settings.horizonAge} onChange={event => updateSettings({ horizonAge: numberValue(event.target.value) })} /></Field>
            <Field label="COLA / inflation %"><input type="number" min={0} max={10} step={0.1} className={`${INPUT} font-mono`} value={state.profile.settings.colaPct} onChange={event => updateSettings({ colaPct: numberValue(event.target.value) })} /></Field>
            <Field label="Real return %"><input type="number" min={-5} max={15} step={0.1} className={`${INPUT} font-mono`} value={state.profile.settings.realReturnPct} onChange={event => updateSettings({ realReturnPct: numberValue(event.target.value) })} /></Field>
            <Field label="Sequencing preference">
              <select className={INPUT} value={state.profile.settings.sequencingPreference} onChange={event => updateSettings({ sequencingPreference: event.target.value as RetirementIncomeSettings['sequencingPreference'] })}>
                {Object.entries(SEQUENCING_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </FieldGrid>
          {household && !household.filingStatus && (
            <p className="mt-3 text-xs text-foreground-muted">
              No household filing status is set, so this projection uses{' '}
              {FILING_STATUS_LABELS[household.effectiveFilingStatus]}. Set it once in{' '}
              <Link href="/settings" className={SETTINGS_LINK}>Settings</Link> to share it across every pack.
            </p>
          )}
        </Panel>
      </div>

      <Panel title="Claiming comparison" description="Monthly and cumulative benefits at 62, full retirement age, and 70, with pairwise breakeven ages. COLAs compound from age 62 on every option.">
        {!analysis || analysis.people.length === 0 ? <Empty>Add a person to compare claiming ages.</Empty> : (
          <div className="space-y-4">
            {analysis.people.map(person => (
              <div key={person.personId}>
                <h3 className="mb-1 text-sm font-semibold text-foreground">{person.name || 'Person'}</h3>
                {person.piaSource === 'missing' ? (
                  <p className="text-xs text-warning">No PIA available — enter a monthly PIA or annual earnings.</p>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse" style={TNUM}>
                        <thead>
                          <tr className="border-b border-border">
                            <th className={TH}>Claim age</th>
                            <th className={`${TH} text-right`}>Adjustment</th>
                            <th className={`${TH} text-right`}>Monthly</th>
                            <th className={`${TH} text-right`}>Annual</th>
                            <th className={`${TH} text-right`}>Lifetime to {analysis.settings.horizonAge}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {person.options.map(option => {
                            const recommended = option.label === person.recommendedLabel;
                            return (
                              <tr key={option.label} className="border-b border-border/50">
                                <td className={TD}>
                                  {option.label}
                                  {recommended && <span className="ml-2 rounded border border-positive/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-positive">Recommended</span>}
                                  {option.claimAgeYears === person.plannedClaimAge && <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-foreground-secondary">Planned</span>}
                                </td>
                                <td className={TD_NUM}>{(option.adjustment * 100).toFixed(1)}%</td>
                                <td className={TD_NUM}>{formatCurrency(option.monthlyBenefit)}</td>
                                <td className={TD_NUM}>{formatCurrency(option.annualBenefit)}</td>
                                <td className={TD_NUM}>{formatCurrency(option.lifetimeTotal)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-2 text-xs text-foreground-muted">
                      Breakevens: {person.breakevens.map(row =>
                        `${row.laterLabel} overtakes ${row.earlierLabel} at ${row.breakevenAge != null ? `age ${row.breakevenAge}` : 'no age within the horizon'}`).join(' · ')}.
                    </p>
                    {person.lifetimeDelta > 0 && (
                      <p className="mt-1 text-xs text-warning">
                        Claiming at {person.recommendedLabel} instead of {person.plannedClaimAge} projects {formatCurrency(person.lifetimeDelta)} more cumulative benefits. This ranking ignores taxes and portfolio interaction.
                      </p>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Sequencing comparison" description={<>The existing drawdown engine runs the full spend-down (<Abbr term="RMD">RMDs</Abbr>, federal tax, Social Security) under each withdrawal order.</>}>
        {!sequencing ? <Empty>Add a person and balances to run the withdrawal-order comparison.</Empty> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" style={TNUM}>
                <thead>
                  <tr className="border-b border-border">
                    <th className={TH}>Withdrawal order</th>
                    <th className={`${TH} text-right`}>Ending value at {analysis!.settings.horizonAge}</th>
                    <th className={`${TH} text-right`}>Lifetime tax</th>
                    <th className={`${TH} text-right`}>Depletion age</th>
                    <th className={`${TH} text-right`}>First-year <Abbr term="AGI" hideIcon /></th>
                  </tr>
                </thead>
                <tbody>
                  {sequencing.variants.map(variant => (
                    <tr key={variant.id} className="border-b border-border/50">
                      <td className={TD}>
                        {variant.label}
                        {variant.id === sequencing.bestVariantId && <span className="ml-2 rounded border border-positive/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-positive">Best</span>}
                        {variant.id === sequencing.preferredVariantId && <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-foreground-secondary">Preference</span>}
                      </td>
                      <td className={TD_NUM}>{formatCurrency(variant.endingTotal)}</td>
                      <td className={TD_NUM}>{formatCurrency(variant.lifetimeTax)}</td>
                      <td className={TD_NUM}>{variant.depletionAge ?? '—'}</td>
                      <td className={TD_NUM}>{formatCurrency(variant.firstYearAgi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!sequencing.preferenceSupported && (
              <p className="mt-2 text-xs text-foreground-muted">A proportional blend cannot be expressed as a withdrawal order in the drawdown engine, so the comparison covers taxable-first and traditional-first.</p>
            )}
            {sequencing.endingValueDelta > 0 && bestVariant && (
              <p className="mt-2 text-xs text-warning">
                {bestVariant.label} projects {formatCurrency(sequencing.endingValueDelta)} more ending portfolio value than your preference.
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel title={<><Abbr term="IRMAA" /> headroom</>} description={<>First-year <Abbr term="MAGI" /> proxy measured against the 2026 Medicare IRMAA tiers (two-year lookback applies from age 63).</>}>
        {!irmaa ? <Empty>Add a person and balances to project first-year MAGI.</Empty> : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric label={`Projected MAGI (${irmaa.year})`} value={formatCurrency(irmaa.magi)} />
              <Metric label="IRMAA tier" value={irmaa.tier === 0 ? 'Below tier 1' : `Tier ${irmaa.tier}`} tone={irmaa.tier > 0 ? 'warning' : 'positive'} />
              <Metric label="Headroom to next tier" value={irmaa.headroomToNextTier != null ? formatCurrency(irmaa.headroomToNextTier) : '—'} tone={irmaa.withinCliff ? 'negative' : undefined} />
              <Metric label="Surcharge if crossed" value={`${formatCurrency(irmaa.surchargeDeltaAnnual)}/yr`} />
            </div>
            {irmaa.withinCliff && (
              <p className="mt-3 text-xs text-negative">
                MAGI is within {formatCurrency(irmaa.headroomToNextTier ?? 0)} of the next IRMAA threshold — a small extra withdrawal or conversion could raise Medicare premiums by {formatCurrency(irmaa.surchargeDeltaAnnual)} per enrollee per year.
              </p>
            )}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse" style={TNUM}>
                <thead>
                  <tr className="border-b border-border">
                    <th className={TH}>Tier</th>
                    <th className={`${TH} text-right`}>MAGI above</th>
                    <th className={`${TH} text-right`}>Monthly surcharge</th>
                    <th className={`${TH} text-right`}>Annual surcharge</th>
                  </tr>
                </thead>
                <tbody>
                  {irmaa.tiers.map(row => (
                    <tr key={row.tier} className={`border-b border-border/50 ${irmaa.tier === row.tier ? 'bg-background-secondary/60' : ''}`}>
                      <td className={TD}>Tier {row.tier}</td>
                      <td className={TD_NUM}>{formatCurrency(row.threshold)}</td>
                      <td className={TD_NUM}>{formatCurrency(row.monthlySurcharge)}</td>
                      <td className={TD_NUM}>{formatCurrency(row.annualSurcharge)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>

      <Panel title="RMD context" description="SECURE 2.0 start ages and a first-year estimate from the traditional balance grown at the real return.">
        {!analysis || analysis.rmd.length === 0 ? <Empty>Add a person to see required minimum distribution timing.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" style={TNUM}>
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Person</th>
                  <th className={`${TH} text-right`}>RMD start age</th>
                  <th className={`${TH} text-right`}>First RMD year</th>
                  <th className={`${TH} text-right`}>Estimated first RMD</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rmd.map(row => (
                  <tr key={row.personId} className="border-b border-border/50">
                    <td className={TD}>{row.name || 'Person'}</td>
                    <td className={TD_NUM}>{row.rmdStartAge}</td>
                    <td className={TD_NUM}>{row.firstRmdYear}</td>
                    <td className={TD_NUM}>{formatCurrency(row.estimatedFirstRmd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {analysis && (
        <Panel title="Assumptions" description="Every simplification behind the numbers above. Planning estimates only — not tax, Social Security, or investment advice.">
          <ul className="list-disc pl-4 text-xs text-foreground-muted">
            {analysis.assumptions.map(assumption => <li key={assumption}>{assumption}</li>)}
          </ul>
        </Panel>
      )}

      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}
