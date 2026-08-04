'use client';

import { useEffect, useId, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import { useHouseholdMembers, type HouseholdMember } from '@/lib/hooks/useHouseholdNames';
import type { calculateEstateReadiness } from '@/lib/resilience/estate-core';
import type { EstateDocumentSuggestion } from '@/lib/resilience/estate-parse';
import type {
  EstateDesignation,
  EstateDocument,
  EstateLifeEvent,
  EstateMemberRole,
  EstateProfile,
  EstateSettings,
} from '@/lib/resilience/types';
import { DocumentChip, DocumentLinkField, type VaultDocument } from './DocumentLinkField';
import { Empty, Field, FieldGrid, INPUT, Metric, Panel, SaveBar, TNUM } from './ui';
import { Abbr } from '@/components/ui/Abbr';

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

const MEMBER_ROLE_LABELS: Record<EstateMemberRole, string> = {
  household: 'Household (joint)',
  self: 'Self',
  spouse: 'Spouse',
  dependent: 'Dependent / other person',
};

const MEMBER_ROLE_ORDER: EstateMemberRole[] = ['household', 'self', 'spouse', 'dependent'];

const EDIT_BUTTON = 'rounded-md border border-border px-2.5 py-1 text-xs text-foreground-secondary transition-colors hover:border-primary hover:text-primary';
const SMALL_PRIMARY = 'rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50';

/** "Cara Crawford" when a name is recorded, otherwise the role label. */
function memberDisplay(record: { memberRole?: EstateMemberRole; memberName?: string }): string {
  const name = record.memberName?.trim();
  if (name) return name;
  return MEMBER_ROLE_LABELS[record.memberRole ?? 'household'];
}

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

/**
 * Member attribution control: a role select plus a display-name snapshot.
 * The roster has no stable per-member id, so the name is stored alongside the
 * role — which also lets a record name someone who is not on the roster (an
 * aging parent, for example) under the 'dependent' role.
 *
 * Renders two labelled fields so each control gets a full column of a
 * `FieldGrid` rather than being squeezed into half of one.
 */
function MemberField(props: {
  role: EstateMemberRole;
  name: string;
  members: HouseholdMember[];
  onChange: (patch: { memberRole: EstateMemberRole; memberName: string }) => void;
}) {
  const listId = useId();
  const rosterNames = props.members.map(member => member.name).filter(Boolean);
  return (
    <>
      <Field label="Belongs to">
        <select
          className={INPUT}
          aria-label="Belongs to"
          value={props.role}
          onChange={event => {
            const memberRole = event.target.value as EstateMemberRole;
            // Prefill the name from the roster when the new role has exactly one match.
            const matches = props.members.filter(member => member.role === memberRole && member.name);
            const memberName = memberRole === 'household'
              ? ''
              : matches.length === 1 ? matches[0].name : props.name;
            props.onChange({ memberRole, memberName });
          }}
        >
          {MEMBER_ROLE_ORDER.map(role => (
            <option key={role} value={role}>{MEMBER_ROLE_LABELS[role]}</option>
          ))}
        </select>
      </Field>
      <Field label="Member name">
        <input
          className={INPUT}
          aria-label="Member name"
          list={listId}
          placeholder={props.role === 'household' ? 'Joint — no single owner' : 'Name'}
          disabled={props.role === 'household'}
          value={props.name}
          onChange={event => props.onChange({ memberRole: props.role, memberName: event.target.value })}
        />
        <datalist id={listId}>
          {rosterNames.map(name => <option key={name} value={name} />)}
        </datalist>
      </Field>
    </>
  );
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
  const toast = useToast();
  const householdMembers = useHouseholdMembers();
  const state = useSection<EstateProfile, EstateResponse>('estate', {
    designations: [],
    documents: [],
    lifeEvents: [],
    settings: DEFAULT_SETTINGS,
  });
  // Document ids currently in edit mode; a freshly loaded page renders read-only.
  const [editingDocuments, setEditingDocuments] = useState<string[]>([]);
  const [vaultDocs, setVaultDocs] = useState<VaultDocument[]>([]);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/business/documents', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : { documents: [] })
      .then((json: { documents?: VaultDocument[] }) => setVaultDocs((json.documents ?? []).map(doc => ({
        id: doc.id, title: doc.title, fileName: doc.fileName, docType: doc.docType, mimeType: doc.mimeType,
      }))))
      .catch(() => { /* vault stays empty — linking is optional */ });
    fetch('/api/resilience/estate/parse', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : { configured: false })
      .then((json: { configured?: boolean }) => setAiConfigured(Boolean(json.configured)))
      .catch(() => setAiConfigured(false));
  }, []);

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
    designations: [...state.profile.designations, { id: uid(), accountLabel: '', accountType: 'retirement', primaryBeneficiary: '', contingentBeneficiary: null, lastReviewedDate: today(), memberRole: 'household', memberName: '' }],
  });
  const addDocument = () => {
    const document: EstateDocument = {
      id: uid(),
      kind: 'will',
      label: null,
      location: '',
      lastUpdatedDate: today(),
      reviewCycleYears: state.profile.settings.reviewCycleYearsDefault,
      memberRole: 'household',
      memberName: '',
      documentId: null,
    };
    state.change({ ...state.profile, documents: [...state.profile.documents, document] });
    setEditingDocuments(current => [...current, document.id]);
  };
  const addLifeEvent = () => state.change({
    ...state.profile,
    lifeEvents: [...state.profile.lifeEvents, { id: uid(), date: today(), kind: 'birth', description: null }],
  });

  const parseDocument = async (document: EstateDocument) => {
    if (!document.documentId) return;
    setParsingId(document.id);
    try {
      const response = await fetch('/api/resilience/estate/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: document.documentId }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Parse failed');
      const suggestion = json.suggestion as EstateDocumentSuggestion;
      // Nothing is saved here: the form is prefilled for the user to review.
      const patch: Partial<EstateDocument> = {};
      if (suggestion.kind) patch.kind = suggestion.kind;
      if (suggestion.executionDate) patch.lastUpdatedDate = suggestion.executionDate;
      if (suggestion.memberRole) {
        patch.memberRole = suggestion.memberRole;
        patch.memberName = suggestion.memberName ?? suggestion.principalName ?? '';
      } else if (suggestion.principalName && !document.memberName) {
        patch.memberName = suggestion.principalName;
      }
      const notes: string[] = [];
      if (suggestion.agentNames.length > 0) notes.push(`Agents: ${suggestion.agentNames.join(', ')}`);
      if (suggestion.state) notes.push(`Executed in ${suggestion.state}`);
      if (suggestion.notarized) notes.push('Notarized');
      if (notes.length > 0 && !document.label) patch.label = notes.join(' · ').slice(0, 200);
      updateDocument(document.id, patch);
      toast.success('Suggestions filled from the document — review the values, then save');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Parse failed');
    } finally {
      setParsingId(null);
    }
  };

  const renderDocumentRead = (document: EstateDocument) => {
    const row = readiness?.documents.find(item => item.id === document.id);
    return (
      <div key={document.id} className="rounded-md border border-border bg-background/50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded border border-border bg-background-tertiary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-secondary">
              {DOCUMENT_KIND_LABELS[document.kind]}
            </span>
            <span className="text-sm font-semibold text-foreground">{memberDisplay(document)}</span>
            {document.label && <span className="text-xs text-foreground-muted">{document.label}</span>}
          </div>
          <button type="button" onClick={() => setEditingDocuments(current => [...current, document.id])} className={EDIT_BUTTON}>Edit</button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="font-mono text-xs text-foreground-secondary" style={TNUM}>Updated {document.lastUpdatedDate}</span>
          <span className="text-xs text-foreground-muted">{document.location || 'Location not recorded'}</span>
          {document.documentId && (
            <DocumentChip id={document.documentId} doc={vaultDocs.find(doc => doc.id === document.documentId)} />
          )}
        </div>
        <div className="mt-2"><DocumentFlags row={row} /></div>
      </div>
    );
  };

  const renderDocumentEdit = (document: EstateDocument) => (
    <div key={document.id} className="rounded-md border border-primary/40 bg-background/50 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">Editing document</span>
        <button type="button" onClick={() => setEditingDocuments(current => current.filter(item => item !== document.id))} className={EDIT_BUTTON}>Done</button>
      </div>
      <FieldGrid>
        <Field label="Document">
          <select className={INPUT} value={document.kind} onChange={event => updateDocument(document.id, { kind: event.target.value as EstateDocument['kind'] })}>
            {Object.entries(DOCUMENT_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <MemberField
          role={document.memberRole ?? 'household'}
          name={document.memberName ?? ''}
          members={householdMembers}
          onChange={patch => updateDocument(document.id, patch)}
        />
        <Field label="Label (optional)"><input className={INPUT} value={document.label ?? ''} onChange={event => updateDocument(document.id, { label: event.target.value || null })} /></Field>
        <Field label="Location"><input className={INPUT} placeholder="Safe, attorney, vault" value={document.location} onChange={event => updateDocument(document.id, { location: event.target.value })} /></Field>
        <Field label="Last updated"><input type="date" className={`${INPUT} font-mono`} value={document.lastUpdatedDate} onChange={event => updateDocument(document.id, { lastUpdatedDate: event.target.value })} /></Field>
        <Field label="Review cycle (years)"><input type="number" min={1} max={10} className={`${INPUT} font-mono`} value={document.reviewCycleYears} onChange={event => updateDocument(document.id, { reviewCycleYears: numberValue(event.target.value) })} /></Field>
      </FieldGrid>
      <div className="mt-5 border-t border-border/60 pt-4">
        <DocumentLinkField
          label="Vault document"
          value={document.documentId ? [document.documentId] : []}
          max={1}
          docType="estate"
          vaultDocs={vaultDocs}
          uploadTitle={file => `${DOCUMENT_KIND_LABELS[document.kind]}${document.memberName ? ` — ${document.memberName}` : ''} (${file.name})`}
          onChange={next => updateDocument(document.id, { documentId: next[0] ?? null })}
          onUploaded={doc => {
            setVaultDocs(current => [doc, ...current]);
            toast.success('Document uploaded to the vault and linked — save to keep the link');
          }}
          onError={message => toast.error(message)}
          actions={
            <button
              type="button"
              disabled={!aiConfigured || !document.documentId || parsingId === document.id}
              onClick={() => parseDocument(document)}
              className={SMALL_PRIMARY}
              title={!aiConfigured
                ? 'Set up an AI provider under Settings → AI to parse estate documents'
                : !document.documentId
                  ? 'Link or upload an estate document first'
                  : 'Fill this form from the linked document — nothing is saved until you review'}
            >
              {parsingId === document.id ? 'Parsing…' : 'Parse from document'}
            </button>
          }
          hint={!aiConfigured ? (
            <p className="mt-2 text-xs text-foreground-muted">
              AI parsing is unavailable — set up a provider under Settings → AI to fill this form from an uploaded document.
            </p>
          ) : null}
        />
      </div>
      <button
        type="button"
        onClick={() => {
          state.change({ ...state.profile, documents: state.profile.documents.filter(item => item.id !== document.id) });
          setEditingDocuments(current => current.filter(item => item !== document.id));
        }}
        className="mt-4 text-xs text-foreground-muted hover:text-negative"
      >
        Remove document
      </button>
    </div>
  );

  const score = readiness?.score ?? 0;
  const memberCoverage = readiness?.coverage.members ?? [];
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Estate & Beneficiary Readiness"
        subtitle="Beneficiary designations, core estate documents per household member, life-event review triggers, survivor runbook, and federal exemption exposure."
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Metric label="Readiness score" value={`${score}/100`} tone={score >= 80 ? 'positive' : score >= 50 ? 'warning' : 'negative'} />
        <Metric label="Stale designations" value={readiness?.staleDesignationCount ?? 0} tone={(readiness?.staleDesignationCount ?? 0) > 0 ? 'warning' : 'positive'} />
        <Metric label="Document issues" value={readiness?.documentIssueCount ?? 0} tone={(readiness?.documentIssueCount ?? 0) > 0 ? 'warning' : 'positive'} />
        <Metric label="Estate exposure" value={formatCurrency(readiness?.exposure.exposure ?? 0)} tone={(readiness?.exposure.exposure ?? 0) > 0 ? 'negative' : 'positive'} />
      </div>

      {memberCoverage.length > 0 && (
        <Panel
          title="Core coverage by household member"
          description="Each adult needs their own will, financial POA, healthcare POA, and healthcare directive. Documents marked household (joint) count for everyone."
        >
          <div className="space-y-2">
            {memberCoverage.map(member => (
              <div key={member.role} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{member.name || MEMBER_ROLE_LABELS[member.role]}</span>
                  <span className="text-[10px] uppercase tracking-wider text-foreground-muted">{MEMBER_ROLE_LABELS[member.role]}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {member.presentCoreDocuments.map(kind => (
                    <span key={kind} className="rounded-full border border-positive/30 bg-positive/10 px-2 py-0.5 text-[11px] text-positive">
                      {DOCUMENT_KIND_LABELS[kind]}
                    </span>
                  ))}
                  {member.missingCoreDocuments.map(kind => (
                    <span key={kind} className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">
                      Missing {DOCUMENT_KIND_LABELS[kind].toLowerCase()}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel
        title="Beneficiary designations"
        description="Accounts that pass outside the will. A designation goes stale after the review cycle or any recorded life event."
        action={<button type="button" onClick={addDesignation} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add designation</button>}
      >
        {state.profile.designations.length === 0 ? <Empty>Add each account with a named beneficiary — retirement, life insurance, <Abbr term="TOD" />, <Abbr term="POD" />, annuity, <Abbr term="HSA" />.</Empty> : (
          <div className="space-y-2">
            {state.profile.designations.map(designation => {
              const row = readiness?.designations.find(item => item.id === designation.id);
              return (
                <div key={designation.id} className="space-y-3 rounded-md border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {designation.accountLabel || 'New designation'}
                    </span>
                    <button
                      type="button"
                      onClick={() => state.change({ ...state.profile, designations: state.profile.designations.filter(item => item.id !== designation.id) })}
                      className="text-xs text-foreground-muted transition-colors hover:text-negative"
                    >
                      Remove designation
                    </button>
                  </div>
                  <FieldGrid>
                    <Field label="Account"><input className={INPUT} placeholder="e.g. Fidelity 401k" value={designation.accountLabel} onChange={event => updateDesignation(designation.id, { accountLabel: event.target.value })} /></Field>
                    <Field label="Account type">
                      <select className={INPUT} value={designation.accountType} onChange={event => updateDesignation(designation.id, { accountType: event.target.value as EstateDesignation['accountType'] })}>
                        {Object.entries(ACCOUNT_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </Field>
                    <MemberField
                      role={designation.memberRole ?? 'household'}
                      name={designation.memberName ?? ''}
                      members={householdMembers}
                      onChange={patch => updateDesignation(designation.id, patch)}
                    />
                    <Field label="Primary beneficiary"><input className={INPUT} placeholder="Primary beneficiary" value={designation.primaryBeneficiary} onChange={event => updateDesignation(designation.id, { primaryBeneficiary: event.target.value })} /></Field>
                    <Field label="Contingent beneficiary"><input className={INPUT} placeholder="Contingent beneficiary" value={designation.contingentBeneficiary ?? ''} onChange={event => updateDesignation(designation.id, { contingentBeneficiary: event.target.value || null })} /></Field>
                    <Field label="Last reviewed"><input type="date" className={`${INPUT} font-mono`} value={designation.lastReviewedDate} onChange={event => updateDesignation(designation.id, { lastReviewedDate: event.target.value })} /></Field>
                  </FieldGrid>
                  <DesignationFlags row={row} />
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel
        title="Estate documents"
        description="Core coverage means a will, financial POA, healthcare POA, and healthcare directive for each adult. A revocable trust is noted, not required. Link the signed PDF from the document vault and parse it to prefill these fields."
        action={<button type="button" onClick={addDocument} className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add document</button>}
      >
        {state.profile.documents.length === 0 ? <Empty>Add each estate document, who it belongs to, where it physically lives, and when it was last updated.</Empty> : (
          <div className="space-y-3">
            {state.profile.documents.map(document =>
              editingDocuments.includes(document.id) ? renderDocumentEdit(document) : renderDocumentRead(document))}
          </div>
        )}
        {readiness && readiness.coverage.missingCoreDocuments.length > 0 && (
          <p className="mt-3 text-xs text-warning">
            Missing across the household: {readiness.coverage.missingCoreDocuments.map(kind => DOCUMENT_KIND_LABELS[kind].toLowerCase()).join(', ')}.
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
              <div key={event.id} className="space-y-3 rounded-md border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{LIFE_EVENT_LABELS[event.kind]}</span>
                  <button
                    type="button"
                    onClick={() => state.change({ ...state.profile, lifeEvents: state.profile.lifeEvents.filter(item => item.id !== event.id) })}
                    className="text-xs text-foreground-muted transition-colors hover:text-negative"
                  >
                    Remove event
                  </button>
                </div>
                <FieldGrid>
                  <Field label="Date"><input type="date" className={`${INPUT} font-mono`} value={event.date} onChange={changeEvent => updateLifeEvent(event.id, { date: changeEvent.target.value })} /></Field>
                  <Field label="Event">
                    <select className={INPUT} value={event.kind} onChange={changeEvent => updateLifeEvent(event.id, { kind: changeEvent.target.value as EstateLifeEvent['kind'] })}>
                      {Object.entries(LIFE_EVENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </Field>
                  <Field label="Description (optional)"><input className={INPUT} placeholder="Description (optional)" value={event.description ?? ''} onChange={changeEvent => updateLifeEvent(event.id, { description: changeEvent.target.value || null })} /></Field>
                </FieldGrid>
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
        <FieldGrid>
          <Field label="Estimated gross estate"><input type="number" className={`${INPUT} font-mono`} value={state.profile.settings.estimatedGrossEstate} onChange={event => updateSettings({ estimatedGrossEstate: numberValue(event.target.value) })} /></Field>
          <Field label="Marital status">
            <select className={INPUT} value={state.profile.settings.maritalStatus} onChange={event => updateSettings({ maritalStatus: event.target.value as EstateSettings['maritalStatus'] })}>
              <option value="single">Single</option>
              <option value="married">Married</option>
            </select>
          </Field>
          <Field label="State"><input className={`${INPUT} font-mono uppercase`} maxLength={2} value={state.profile.settings.state} onChange={event => updateSettings({ state: event.target.value.toUpperCase() })} /></Field>
          <Field label="Default review cycle (years)"><input type="number" min={1} max={10} className={`${INPUT} font-mono`} value={state.profile.settings.reviewCycleYearsDefault} onChange={event => updateSettings({ reviewCycleYearsDefault: numberValue(event.target.value) })} /></Field>
          <Field label="Survivor runbook location" className="sm:col-span-2"><input className={INPUT} placeholder="e.g. Fireproof safe + shared vault folder" value={state.profile.settings.survivorRunbookLocation ?? ''} onChange={event => updateSettings({ survivorRunbookLocation: event.target.value || null })} /></Field>
          <Field label="Runbook last updated"><input type="date" className={`${INPUT} font-mono`} value={state.profile.settings.survivorRunbookUpdatedDate ?? ''} onChange={event => updateSettings({ survivorRunbookUpdatedDate: event.target.value || null })} /></Field>
        </FieldGrid>
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
