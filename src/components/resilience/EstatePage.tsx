'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { calculateEstateReadiness } from '@/lib/resilience/estate-core';
import type {
  EstateDesignation,
  EstateDocument,
  EstateLifeEvent,
  EstateProfile,
  EstateSettings,
} from '@/lib/resilience/types';
import { Empty, Field, INPUT, Metric, Panel, SaveBar, TNUM } from './ui';

const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const numberValue = (value: string) => Number(value) || 0;

type EstateReadiness = ReturnType<typeof calculateEstateReadiness>;
type EstateResponse = { profile: EstateProfile; readiness: EstateReadiness };

const DEFAULT_SETTINGS: EstateSettings = {
  estimatedGrossEstate: 0,
  maritalStatus: 'married',
  state: 'NC',
  reviewCycleYearsDefault: 3,
  survivorRunbookLocation: null,
  survivorRunbookUpdatedDate: null,
};

const ACCOUNT_TYPE_LABELS: Record<EstateDesignation['accountType'], string> = {
  retirement: 'Retirement',
  life_insurance: 'Life insurance',
  tod_investment: 'TOD investment',
  pod_bank: 'POD bank',
  annuity: 'Annuity',
  hsa: 'HSA',
  other: 'Other',
};

const DOCUMENT_KIND_LABELS: Record<EstateDocument['kind'], string> = {
  will: 'Will',
  revocable_trust: 'Revocable living trust',
  financial_poa: 'Financial power of attorney',
  healthcare_poa: 'Healthcare power of attorney',
  healthcare_directive: 'Healthcare directive',
  guardianship_letter: 'Guardianship letter',
  beneficiary_letter: 'Beneficiary letter',
  other: 'Other',
};

const LIFE_EVENT_LABELS: Record<EstateLifeEvent['kind'], string> = {
  marriage: 'Marriage',
  divorce: 'Divorce',
  birth: 'Birth',
  death: 'Death',
  move: 'Move',
  major_asset_change: 'Major asset change',
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

function DesignationFlags(props: { row: EstateReadiness['designations'][number] | undefined }) {
  if (!props.row?.stale) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <span className="rounded border border-warning/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warning">
        {props.row.staleReason === 'life_event' && props.row.triggeringLifeEvent
          ? `Stale — ${LIFE_EVENT_LABELS[props.row.triggeringLifeEvent.kind].toLowerCase()} on ${props.row.triggeringLifeEvent.date}`
          : `Stale — last reviewed ${props.row.daysSinceReview} days ago`}
      </span>
    </div>
  );
}

function DocumentFlags(props: { row: EstateReadiness['documents'][number] | undefined }) {
  if (!props.row) return null;
  const flags: Array<{ label: string; className: string }> = [];
  if (props.row.overdue) flags.push({ label: `Review overdue since ${props.row.dueDate}`, className: 'text-negative border-negative/40' });
  else flags.push({ label: `Next review ${props.row.dueDate}`, className: 'text-foreground-secondary border-border' });
  if (props.row.lifeEventTrigger) flags.push({ label: `Revisit after ${LIFE_EVENT_LABELS[props.row.lifeEventTrigger.kind].toLowerCase()} on ${props.row.lifeEventTrigger.date}`, className: 'text-warning border-warning/40' });
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

export function EstatePage() {
  const state = useSection<EstateProfile, EstateResponse>('estate', {
    designations: [],
    documents: [],
    lifeEvents: [],
    settings: DEFAULT_SETTINGS,
  });
  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading estate readiness…</div>;
  const readiness = state.response?.readiness;
  const updateDesignation = (id: string, patch: Partial<EstateDesignation>) =>
    state.change({ ...state.profile, designations: state.profile.designations.map(item => item.id === id ? { ...item, ...patch } : item) });
  const updateDocument = (id: string, patch: Partial<EstateDocument>) =>
    state.change({ ...state.profile, documents: state.profile.documents.map(item => item.id === id ? { ...item, ...patch } : item) });
  const updateLifeEvent = (id: string, patch: Partial<EstateLifeEvent>) =>
    state.change({ ...state.profile, lifeEvents: state.profile.lifeEvents.map(item => item.id === id ? { ...item, ...patch } : item) });
  const updateSettings = (patch: Partial<EstateSettings>) =>
    state.change({ ...state.profile, settings: { ...state.profile.settings, ...patch } });
  const addDesignation = () => state.change({
    ...state.profile,
    designations: [...state.profile.designations, { id: uid(), accountLabel: '', accountType: 'retirement', primaryBeneficiary: '', contingentBeneficiary: null, lastReviewedDate: today() }],
  });
  const addDocument = () => state.change({
    ...state.profile,
    documents: [...state.profile.documents, { id: uid(), kind: 'will', label: null, location: '', lastUpdatedDate: today(), reviewCycleYears: state.profile.settings.reviewCycleYearsDefault }],
  });
  const addLifeEvent = () => state.change({
    ...state.profile,
    lifeEvents: [...state.profile.lifeEvents, { id: uid(), date: today(), kind: 'birth', description: null }],
  });
  const score = readiness?.score ?? 0;
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Estate & Beneficiary Readiness"
        subtitle="Beneficiary designations, core estate documents, life-event review triggers, survivor runbook, and federal exemption exposure."
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Metric label="Readiness score" value={`${score}/100`} tone={score >= 80 ? 'positive' : score >= 50 ? 'warning' : 'negative'} />
        <Metric label="Stale designations" value={readiness?.staleDesignationCount ?? 0} tone={(readiness?.staleDesignationCount ?? 0) > 0 ? 'warning' : 'positive'} />
        <Metric label="Document issues" value={readiness?.documentIssueCount ?? 0} tone={(readiness?.documentIssueCount ?? 0) > 0 ? 'warning' : 'positive'} />
        <Metric label="Estate exposure" value={formatCurrency(readiness?.exposure.exposure ?? 0)} tone={(readiness?.exposure.exposure ?? 0) > 0 ? 'negative' : 'positive'} />
      </div>

      <Panel
        title="Beneficiary designations"
        description="Accounts that pass outside the will. A designation goes stale after the review cycle or any recorded life event."
        action={<button type="button" onClick={addDesignation} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add designation</button>}
      >
        {state.profile.designations.length === 0 ? <Empty>Add each account with a named beneficiary — retirement, life insurance, TOD, POD, annuity, HSA.</Empty> : (
          <div className="space-y-2">
            {state.profile.designations.map(designation => {
              const row = readiness?.designations.find(item => item.id === designation.id);
              return (
                <div key={designation.id} className="space-y-2 rounded-md border border-border p-3">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-[1fr_160px_1fr_1fr_140px_auto]">
                    <input className={INPUT} placeholder="Account (e.g. Fidelity 401k)" value={designation.accountLabel} onChange={event => updateDesignation(designation.id, { accountLabel: event.target.value })} />
                    <select className={INPUT} value={designation.accountType} onChange={event => updateDesignation(designation.id, { accountType: event.target.value as EstateDesignation['accountType'] })}>
                      {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <input className={INPUT} placeholder="Primary beneficiary" value={designation.primaryBeneficiary} onChange={event => updateDesignation(designation.id, { primaryBeneficiary: event.target.value })} />
                    <input className={INPUT} placeholder="Contingent beneficiary" value={designation.contingentBeneficiary ?? ''} onChange={event => updateDesignation(designation.id, { contingentBeneficiary: event.target.value || null })} />
                    <input type="date" className={`${INPUT} font-mono`} value={designation.lastReviewedDate} onChange={event => updateDesignation(designation.id, { lastReviewedDate: event.target.value })} />
                    <button type="button" onClick={() => state.change({ ...state.profile, designations: state.profile.designations.filter(item => item.id !== designation.id) })} className="px-2 text-negative">×</button>
                  </div>
                  <DesignationFlags row={row} />
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel
        title="Estate documents"
        description="Core coverage means a will, financial POA, healthcare POA, and healthcare directive. A revocable trust is noted, not required."
        action={<button type="button" onClick={addDocument} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add document</button>}
      >
        {state.profile.documents.length === 0 ? <Empty>Add each estate document with where it physically lives and when it was last updated.</Empty> : (
          <div className="space-y-2">
            {state.profile.documents.map(document => {
              const row = readiness?.documents.find(item => item.id === document.id);
              return (
                <div key={document.id} className="space-y-2 rounded-md border border-border p-3">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-[220px_1fr_1fr_140px_110px_auto]">
                    <select className={INPUT} value={document.kind} onChange={event => updateDocument(document.id, { kind: event.target.value as EstateDocument['kind'] })}>
                      {Object.entries(DOCUMENT_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <input className={INPUT} placeholder="Label (optional)" value={document.label ?? ''} onChange={event => updateDocument(document.id, { label: event.target.value || null })} />
                    <input className={INPUT} placeholder="Location (safe, attorney, vault link)" value={document.location} onChange={event => updateDocument(document.id, { location: event.target.value })} />
                    <input type="date" className={`${INPUT} font-mono`} value={document.lastUpdatedDate} onChange={event => updateDocument(document.id, { lastUpdatedDate: event.target.value })} />
                    <input type="number" min={1} max={10} className={`${INPUT} font-mono`} title="Review cycle (years)" value={document.reviewCycleYears} onChange={event => updateDocument(document.id, { reviewCycleYears: numberValue(event.target.value) })} />
                    <button type="button" onClick={() => state.change({ ...state.profile, documents: state.profile.documents.filter(item => item.id !== document.id) })} className="px-2 text-negative">×</button>
                  </div>
                  <DocumentFlags row={row} />
                </div>
              );
            })}
          </div>
        )}
        {readiness && readiness.coverage.missingCoreDocuments.length > 0 && (
          <p className="mt-3 text-xs text-warning">
            Missing core documents: {readiness.coverage.missingCoreDocuments.map(kind => DOCUMENT_KIND_LABELS[kind].toLowerCase()).join(', ')}.
          </p>
        )}
        {readiness?.coverage.hasRevocableTrust && (
          <p className="mt-1 text-xs text-foreground-muted">A revocable living trust is on file — confirm titled assets and designations actually name it.</p>
        )}
      </Panel>

      <Panel
        title="Life events"
        description="Marriage, divorce, birth, and death trigger document reviews; any event marks earlier beneficiary reviews stale."
        action={<button type="button" onClick={addLifeEvent} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add event</button>}
      >
        {state.profile.lifeEvents.length === 0 ? <Empty>Record life events so reviews done before them are flagged automatically.</Empty> : (
          <div className="space-y-2">
            {state.profile.lifeEvents.slice().sort((a, b) => b.date.localeCompare(a.date)).map(event => (
              <div key={event.id} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 md:grid-cols-[140px_200px_1fr_auto]">
                <input type="date" className={`${INPUT} font-mono`} value={event.date} onChange={changeEvent => updateLifeEvent(event.id, { date: changeEvent.target.value })} />
                <select className={INPUT} value={event.kind} onChange={changeEvent => updateLifeEvent(event.id, { kind: changeEvent.target.value as EstateLifeEvent['kind'] })}>
                  {Object.entries(LIFE_EVENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <input className={INPUT} placeholder="Description (optional)" value={event.description ?? ''} onChange={changeEvent => updateLifeEvent(event.id, { description: changeEvent.target.value || null })} />
                <button type="button" onClick={() => state.change({ ...state.profile, lifeEvents: state.profile.lifeEvents.filter(item => item.id !== event.id) })} className="px-2 text-negative">×</button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Federal estate exposure" description="Estimated gross estate measured against the 2026 federal exemption.">
        {readiness ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric label="Gross estate" value={formatCurrency(readiness.exposure.grossEstate)} />
              <Metric label="Exemption applied" value={formatCurrency(readiness.exposure.exemptionApplied)} />
              <Metric label="Exposure" value={formatCurrency(readiness.exposure.exposure)} tone={readiness.exposure.exposure > 0 ? 'negative' : 'positive'} />
              <Metric label={`Estimated tax (${readiness.exposure.topRatePct.toFixed(0)}%)`} value={formatCurrency(readiness.exposure.estimatedTax)} tone={readiness.exposure.estimatedTax > 0 ? 'negative' : undefined} />
            </div>
            <p className="mt-3 text-xs text-foreground-muted">{readiness.exposure.formula}.</p>
            <ul className="mt-1 list-disc pl-4 text-xs text-foreground-muted">
              {readiness.exposure.assumptions.map(assumption => <li key={assumption}>{assumption}</li>)}
            </ul>
            <p className="mt-2 text-xs text-foreground-muted">Planning estimate, not legal or tax advice.</p>
          </>
        ) : <Empty>Save settings to compute exposure.</Empty>}
      </Panel>

      <Panel title="Settings & survivor runbook" description="Household inputs and the runbook survivors would follow first.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label="Estimated gross estate"><input type="number" className={`${INPUT} font-mono`} value={state.profile.settings.estimatedGrossEstate} onChange={event => updateSettings({ estimatedGrossEstate: numberValue(event.target.value) })} /></Field>
          <Field label="Marital status">
            <select className={INPUT} value={state.profile.settings.maritalStatus} onChange={event => updateSettings({ maritalStatus: event.target.value as EstateSettings['maritalStatus'] })}>
              <option value="single">Single</option>
              <option value="married">Married</option>
            </select>
          </Field>
          <Field label="State"><input className={`${INPUT} font-mono uppercase`} maxLength={2} value={state.profile.settings.state} onChange={event => updateSettings({ state: event.target.value.toUpperCase() })} /></Field>
          <Field label="Default review cycle (years)"><input type="number" min={1} max={10} className={`${INPUT} font-mono`} value={state.profile.settings.reviewCycleYearsDefault} onChange={event => updateSettings({ reviewCycleYearsDefault: numberValue(event.target.value) })} /></Field>
          <Field label="Survivor runbook location" className="col-span-2"><input className={INPUT} placeholder="e.g. Fireproof safe + shared vault folder" value={state.profile.settings.survivorRunbookLocation ?? ''} onChange={event => updateSettings({ survivorRunbookLocation: event.target.value || null })} /></Field>
          <Field label="Runbook last updated"><input type="date" className={`${INPUT} font-mono`} value={state.profile.settings.survivorRunbookUpdatedDate ?? ''} onChange={event => updateSettings({ survivorRunbookUpdatedDate: event.target.value || null })} /></Field>
        </div>
        {readiness && (
          <p className={`mt-3 text-xs ${readiness.runbook.current ? 'text-foreground-muted' : 'text-warning'}`}>
            {readiness.runbook.current
              ? `Survivor runbook is current — updated ${readiness.runbook.daysSinceUpdate} days ago.`
              : readiness.runbook.present
                ? 'Survivor runbook is on file but has not been updated within two years.'
                : 'No survivor runbook recorded. Write down accounts, advisors, passwords location, and first steps for survivors.'}
          </p>
        )}
      </Panel>

      <SaveBar saving={state.saving} dirty={state.dirty} onSave={state.save} />
    </div>
  );
}
