'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { InsurancePolicySuggestion } from '@/lib/resilience/insurance-parse';
import { HOUSEHOLD_ROLE_LABELS } from '@/lib/resilience/household';
import type {
  CapitalAsset,
  CapitalProfile,
  HouseholdMember,
  HouseholdRole,
  InsurancePolicy,
  InsuranceProfile,
  LifePerson,
  LifeProfile,
} from '@/lib/resilience/types';
import { Empty, Field, FieldGrid, INPUT, Metric, Panel, SaveBar, Tabs, TNUM } from '@/components/resilience/ui';
import { DocumentChip, type VaultDocument } from '@/components/resilience/DocumentLinkField';

type Tab = 'insurance' | 'capital' | 'life';
const uid = () => crypto.randomUUID();
const currentYear = new Date().getFullYear();

const POLICY_TYPE_LABELS: Record<InsurancePolicy['type'], string> = {
  home: 'Home',
  renters: 'Renters',
  auto: 'Auto',
  umbrella: 'Umbrella',
  life: 'Life',
  health: 'Health',
  other: 'Other',
};

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
  /** Household roster from Settings; absent on responses from an older server. */
  household?: { members: HouseholdMember[] };
}

/** "Cara Crawford (Spouse)" when named, else just the role label. */
function memberLabel(member: HouseholdMember): string {
  const role = HOUSEHOLD_ROLE_LABELS[member.role];
  return member.name ? `${member.name} (${role})` : role;
}

/** Whole days until an ISO date (negative when past). */
function daysUntil(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const target = new Date(`${iso}T00:00:00Z`).getTime();
  if (Number.isNaN(target)) return null;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

function TypeBadge(props: { type: InsurancePolicy['type'] }) {
  return (
    <span className="rounded border border-border bg-background-tertiary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-secondary">
      {POLICY_TYPE_LABELS[props.type]}
    </span>
  );
}

function RenewalChip(props: { date: string }) {
  const days = daysUntil(props.date);
  if (days === null) return null;
  if (days < 0) {
    return (
      <span className="whitespace-nowrap rounded-full border border-negative/30 bg-negative/10 px-2 py-0.5 text-[11px] font-medium text-negative">
        Renewal overdue — {props.date}
      </span>
    );
  }
  if (days <= 60) {
    return (
      <span className="whitespace-nowrap rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
        Renews in {days}d — {props.date}
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap rounded-full border border-border bg-background-tertiary px-2 py-0.5 text-[11px] text-foreground-muted">
      Renews {props.date}
    </span>
  );
}

/** Small labelled value for read-mode cards. */
function Stat(props: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">{props.label}</p>
      <p className="mt-0.5 font-mono text-sm text-foreground" style={TNUM}>{props.value}</p>
    </div>
  );
}

const EDIT_BUTTON = 'rounded-md border border-border px-2.5 py-1 text-xs text-foreground-secondary transition-colors hover:border-primary hover:text-primary';
const SMALL_PRIMARY = 'rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50';

export default function ProtectionPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('insurance');
  const [insurance, setInsurance] = useState<InsuranceResponse | null>(null);
  const [capital, setCapital] = useState<CapitalResponse | null>(null);
  const [life, setLife] = useState<LifeResponse | null>(null);
  const [dirty, setDirty] = useState<Record<Tab, boolean>>({ insurance: false, capital: false, life: false });
  const [saving, setSaving] = useState(false);
  // Item ids currently in edit mode; freshly loaded pages render read-only.
  const [editing, setEditing] = useState<Record<Tab, string[]>>({ insurance: [], capital: [], life: [] });
  const [vaultDocs, setVaultDocs] = useState<VaultDocument[]>([]);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setEditing({ insurance: [], capital: [], life: [] });
  };

  const loadVaultDocs = async () => {
    try {
      const response = await fetch('/api/business/documents', { cache: 'no-store' });
      if (!response.ok) return;
      const json = await response.json() as { documents?: VaultDocument[] };
      setVaultDocs((json.documents ?? []).map(doc => ({
        id: doc.id, title: doc.title, fileName: doc.fileName, docType: doc.docType, mimeType: doc.mimeType,
      })));
    } catch { /* vault stays empty — linking is optional */ }
  };

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (requested === 'capital' || requested === 'life' || requested === 'insurance') setTab(requested);
    load().catch(() => toast.error('Failed to load protection plan'));
    loadVaultDocs();
    fetch('/api/resilience/insurance/parse', { cache: 'no-store' })
      .then(response => response.ok ? response.json() : { configured: false })
      .then((json: { configured?: boolean }) => setAiConfigured(Boolean(json.configured)))
      .catch(() => setAiConfigured(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isEditing = (id: string) => editing[tab].includes(id);
  const openEditor = (id: string) =>
    setEditing(current => ({ ...current, [tab]: current[tab].includes(id) ? current[tab] : [...current[tab], id] }));
  const closeEditor = (id: string) =>
    setEditing(current => ({ ...current, [tab]: current[tab].filter(item => item !== id) }));

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
      setEditing(current => ({ ...current, [tab]: [] }));
      toast.success(`${tab === 'life' ? 'Life needs' : tab[0].toUpperCase() + tab.slice(1)} plan saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    load().catch(() => toast.error('Failed to reload protection plan'));
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
    setEditing(current => ({ ...current, insurance: [...current.insurance, policy.id] }));
  };

  const updatePolicy = (id: string, patch: Partial<InsurancePolicy>) => {
    setInsurance(current => current ? {
      ...current,
      profile: { policies: current.profile.policies.map(policy => policy.id === id ? { ...policy, ...patch } : policy) },
    } : current);
    setDirty(current => ({ ...current, insurance: true }));
  };

  const removePolicy = (id: string) => {
    if (!insurance) return;
    setInsurance({ ...insurance, profile: { policies: insurance.profile.policies.filter(item => item.id !== id) } });
    setDirty(current => ({ ...current, insurance: true }));
  };

  const uploadDocumentForPolicy = async (policy: InsurancePolicy, file: File) => {
    setUploadingId(policy.id);
    try {
      // Reuses the document vault's own upload endpoint — no parallel path.
      const formData = new FormData();
      formData.append('file', file);
      formData.append('title', policy.provider ? `${policy.provider} policy — ${file.name}` : file.name);
      formData.append('doc_type', 'insurance');
      const response = await fetch('/api/business/documents', { method: 'POST', body: formData });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Upload failed');
      const doc = json.document as VaultDocument;
      setVaultDocs(current => [{ id: doc.id, title: doc.title, fileName: doc.fileName, docType: doc.docType, mimeType: doc.mimeType }, ...current]);
      updatePolicy(policy.id, { documentIds: [...policy.documentIds, doc.id] });
      toast.success('Document uploaded to the vault and linked — save to keep the link');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploadingId(null);
    }
  };

  const parsePolicyDocument = async (policy: InsurancePolicy) => {
    const documentId = policy.documentIds.at(-1);
    if (!documentId) return;
    setParsingId(policy.id);
    try {
      const response = await fetch('/api/resilience/insurance/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Parse failed');
      const suggestion = json.suggestion as InsurancePolicySuggestion;
      const patch: Partial<InsurancePolicy> = {};
      if (suggestion.provider) patch.provider = suggestion.provider;
      if (suggestion.policyType) patch.type = suggestion.policyType;
      if (suggestion.coveredEntity) patch.coveredEntity = suggestion.coveredEntity;
      if (suggestion.coverageLimit !== null) patch.coverageLimit = suggestion.coverageLimit;
      if (suggestion.deductible !== null) patch.deductible = suggestion.deductible;
      if (suggestion.annualPremium !== null) patch.annualPremium = suggestion.annualPremium;
      if (suggestion.renewalDate) patch.renewalDate = suggestion.renewalDate;
      if (suggestion.policyNumberMasked && !policy.policyNumber) patch.policyNumber = suggestion.policyNumberMasked;
      if (suggestion.sublimits.length > 0) {
        patch.sublimits = suggestion.sublimits.map(item => ({ id: uid(), category: item.category, limit: item.limit }));
      }
      updatePolicy(policy.id, patch);
      toast.success('Suggestions filled from the document — review the values, then save');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Parse failed');
    } finally {
      setParsingId(null);
    }
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
    setEditing(current => ({ ...current, capital: [...current.capital, asset.id] }));
  };

  const updateCapital = (id: string, patch: Partial<CapitalAsset>) => {
    if (!capital) return;
    setCapital({
      ...capital,
      profile: { assets: capital.profile.assets.map(asset => asset.id === id ? { ...asset, ...patch } : asset) },
    });
    setDirty(current => ({ ...current, capital: true }));
  };

  // Household roster from Settings — the source of truth for who these people
  // are. Empty when no household members are configured; manual entry then
  // works exactly as it did before.
  const householdMembers = life?.household?.members ?? [];

  const addPerson = () => {
    if (!life) return;
    const person: LifePerson = {
      id: uid(),
      memberRole: null,
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
    setEditing(current => ({ ...current, life: [...current.life, person.id] }));
  };

  const updatePerson = (id: string, patch: Partial<LifePerson>) => {
    if (!life) return;
    setLife({
      ...life,
      profile: { people: life.profile.people.map(person => person.id === id ? { ...person, ...patch } : person) },
    });
    setDirty(current => ({ ...current, life: true }));
  };

  const renderPolicyRead = (policy: InsurancePolicy) => {
    const last4 = policy.policyNumber ? policy.policyNumber.slice(-4) : '';
    return (
      <div key={policy.id} className="rounded-md border border-border bg-background/50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge type={policy.type} />
            <span className="text-sm font-semibold text-foreground">{policy.provider || 'Unnamed provider'}</span>
            {policy.coveredEntity && <span className="text-xs text-foreground-muted">{policy.coveredEntity}</span>}
            {last4 && <span className="font-mono text-xs text-foreground-muted" style={TNUM}>Policy …{last4}</span>}
          </div>
          <div className="flex items-center gap-2">
            <RenewalChip date={policy.renewalDate} />
            <button type="button" onClick={() => openEditor(policy.id)} className={EDIT_BUTTON}>Edit</button>
          </div>
        </div>
        <div className="mt-3 grid max-w-md grid-cols-3 gap-3">
          <Stat label="Coverage limit" value={formatCurrency(policy.coverageLimit)} />
          <Stat label="Deductible" value={formatCurrency(policy.deductible)} />
          <Stat label="Annual premium" value={formatCurrency(policy.annualPremium)} />
        </div>
        {policy.sublimits.length > 0 && (
          <p className="mt-3 text-xs text-foreground-secondary">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">Sub-limits </span>
            {policy.sublimits.map(sublimit => `${sublimit.category} ${formatCurrency(sublimit.limit)}`).join(' · ')}
          </p>
        )}
        {policy.documentIds.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {policy.documentIds.map(id => (
              <DocumentChip key={id} id={id} doc={vaultDocs.find(doc => doc.id === id)} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderPolicyEdit = (policy: InsurancePolicy) => {
    const linkable = vaultDocs.filter(doc => !policy.documentIds.includes(doc.id));
    return (
      <div key={policy.id} className="rounded-md border border-primary/40 bg-background/50 p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">Editing policy</span>
          <button type="button" onClick={() => closeEditor(policy.id)} className={EDIT_BUTTON}>Done</button>
        </div>
        <FieldGrid>
          <Field label="Type"><select className={INPUT} value={policy.type} onChange={event => updatePolicy(policy.id, { type: event.target.value as InsurancePolicy['type'] })}>{(Object.keys(POLICY_TYPE_LABELS) as Array<InsurancePolicy['type']>).map(type => <option key={type} value={type}>{POLICY_TYPE_LABELS[type]}</option>)}</select></Field>
          <Field label="Provider"><input className={INPUT} value={policy.provider} onChange={event => updatePolicy(policy.id, { provider: event.target.value })} /></Field>
          <Field label="Covered entity"><input className={INPUT} value={policy.coveredEntity} onChange={event => updatePolicy(policy.id, { coveredEntity: event.target.value })} /></Field>
          <Field label="Policy number"><input className={INPUT} value={policy.policyNumber} onChange={event => updatePolicy(policy.id, { policyNumber: event.target.value })} /></Field>
          <Field label="Coverage limit"><input type="number" min="0" className={`${INPUT} font-mono`} value={policy.coverageLimit} onChange={event => updatePolicy(policy.id, { coverageLimit: Number(event.target.value) })} /></Field>
          <Field label="Deductible"><input type="number" min="0" className={`${INPUT} font-mono`} value={policy.deductible} onChange={event => updatePolicy(policy.id, { deductible: Number(event.target.value) })} /></Field>
          <Field label="Annual premium"><input type="number" min="0" className={`${INPUT} font-mono`} value={policy.annualPremium} onChange={event => updatePolicy(policy.id, { annualPremium: Number(event.target.value) })} /></Field>
          <Field label="Renewal"><input type="date" className={`${INPUT} font-mono`} value={policy.renewalDate} onChange={event => updatePolicy(policy.id, { renewalDate: event.target.value })} /></Field>
        </FieldGrid>
        {policy.sublimits.length > 0 && (
          <div className="mt-5 space-y-3 border-t border-border/60 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">Category sub-limits</p>
            {policy.sublimits.map(sublimit => (
              <div key={sublimit.id} className="space-y-3 rounded-md border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{sublimit.category || 'New sub-limit'}</span>
                  <button type="button" onClick={() => updatePolicy(policy.id, { sublimits: policy.sublimits.filter(item => item.id !== sublimit.id) })} className="text-xs text-foreground-muted transition-colors hover:text-negative">Remove sub-limit</button>
                </div>
                <FieldGrid cols={2}>
                  <Field label="Category"><input className={INPUT} value={sublimit.category} onChange={event => updatePolicy(policy.id, { sublimits: policy.sublimits.map(item => item.id === sublimit.id ? { ...item, category: event.target.value } : item) })} /></Field>
                  <Field label="Limit"><input type="number" min="0" className={`${INPUT} font-mono`} value={sublimit.limit} onChange={event => updatePolicy(policy.id, { sublimits: policy.sublimits.map(item => item.id === sublimit.id ? { ...item, limit: Number(event.target.value) } : item) })} /></Field>
                </FieldGrid>
              </div>
            ))}
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={() => updatePolicy(policy.id, { sublimits: [...policy.sublimits, { id: uid(), category: 'Jewelry', limit: 0 }] })} className="text-xs text-primary">Add category sub-limit</button>
          <button type="button" onClick={() => removePolicy(policy.id)} className="text-xs text-foreground-muted hover:text-negative">Remove policy</button>
        </div>
        <div className="mt-5 border-t border-border/60 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground-secondary">Policy documents</p>
          {policy.documentIds.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {policy.documentIds.map(id => (
                <DocumentChip
                  key={id}
                  id={id}
                  doc={vaultDocs.find(doc => doc.id === id)}
                  onRemove={() => updatePolicy(policy.id, { documentIds: policy.documentIds.filter(item => item !== id) })}
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {linkable.length > 0 && (
              <select
                className={`${INPUT} w-auto`}
                value=""
                onChange={event => {
                  const id = Number(event.target.value);
                  if (id) updatePolicy(policy.id, { documentIds: [...policy.documentIds, id] });
                }}
              >
                <option value="">Link vault document…</option>
                {linkable.map(doc => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
              </select>
            )}
            <button
              type="button"
              disabled={uploadingId === policy.id}
              onClick={() => {
                uploadTargetRef.current = policy.id;
                fileInputRef.current?.click();
              }}
              className={EDIT_BUTTON}
            >
              {uploadingId === policy.id ? 'Uploading…' : 'Upload document'}
            </button>
            <button
              type="button"
              disabled={!aiConfigured || policy.documentIds.length === 0 || parsingId === policy.id}
              onClick={() => parsePolicyDocument(policy)}
              className={SMALL_PRIMARY}
              title={!aiConfigured
                ? 'Set up an AI provider under Settings → AI to parse policy documents'
                : policy.documentIds.length === 0
                  ? 'Link or upload a policy document first'
                  : 'Fill this form from the linked document — nothing is saved until you review'}
            >
              {parsingId === policy.id ? 'Parsing…' : 'Parse from document'}
            </button>
          </div>
          {!aiConfigured && (
            <p className="mt-2 text-xs text-foreground-muted">
              AI parsing is unavailable — set up a provider under Settings → AI to fill this form from an uploaded policy.
            </p>
          )}
        </div>
      </div>
    );
  };

  const renderCapitalRead = (asset: CapitalAsset, calculated: CapitalResponse['plan']['rows'][number] | undefined) => (
    <div key={asset.id} className="rounded-md border border-border bg-background/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{asset.name || 'Unnamed asset'}</span>
          {asset.category && <span className="text-xs text-foreground-muted">{asset.category}</span>}
          {calculated?.overdue && (
            <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">Replacement overdue</span>
          )}
        </div>
        <button type="button" onClick={() => openEditor(asset.id)} className={EDIT_BUTTON}>Edit</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Installed" value={String(asset.installedYear)} />
        <Stat label="Cost today" value={formatCurrency(asset.currentReplacementCost)} />
        <Stat label="Already funded" value={formatCurrency(asset.fundedAmount)} />
        <Stat label="Replace in" value={calculated ? String(calculated.replacementYear) : '—'} />
        <Stat label="Monthly funding" value={calculated ? `${formatCurrency(calculated.monthlyFunding)}/mo` : 'Save to calculate'} />
      </div>
    </div>
  );

  const renderCapitalEdit = (asset: CapitalAsset, calculated: CapitalResponse['plan']['rows'][number] | undefined) => (
    <div key={asset.id} className="rounded-md border border-primary/40 bg-background/50 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">Editing asset</span>
        <button type="button" onClick={() => closeEditor(asset.id)} className={EDIT_BUTTON}>Done</button>
      </div>
      <FieldGrid>
        <Field label="Asset"><input className={INPUT} value={asset.name} onChange={event => updateCapital(asset.id, { name: event.target.value })} /></Field>
        <Field label="Category"><input className={INPUT} value={asset.category} onChange={event => updateCapital(asset.id, { category: event.target.value })} /></Field>
        <Field label="Installed year"><input type="number" className={`${INPUT} font-mono`} value={asset.installedYear} onChange={event => updateCapital(asset.id, { installedYear: Number(event.target.value) })} /></Field>
        <Field label="Expected life (years)"><input type="number" min="1" className={`${INPUT} font-mono`} value={asset.expectedLifeYears} onChange={event => updateCapital(asset.id, { expectedLifeYears: Number(event.target.value) })} /></Field>
        <Field label="Cost today"><input type="number" min="0" className={`${INPUT} font-mono`} value={asset.currentReplacementCost} onChange={event => updateCapital(asset.id, { currentReplacementCost: Number(event.target.value) })} /></Field>
        <Field label="Inflation %"><input type="number" min="0" max="30" step="0.1" className={`${INPUT} font-mono`} value={asset.inflationRate} onChange={event => updateCapital(asset.id, { inflationRate: Number(event.target.value) })} /></Field>
        <Field label="Already funded"><input type="number" min="0" className={`${INPUT} font-mono`} value={asset.fundedAmount} onChange={event => updateCapital(asset.id, { fundedAmount: Number(event.target.value) })} /></Field>
      </FieldGrid>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-xs text-foreground-secondary" style={TNUM}>{calculated ? `${calculated.replacementYear} · ${formatCurrency(calculated.monthlyFunding)}/mo` : 'Save to calculate'}</span>
        <button type="button" onClick={() => {
          if (!capital) return;
          setCapital({ ...capital, profile: { assets: capital.profile.assets.filter(item => item.id !== asset.id) } });
          setDirty(current => ({ ...current, capital: true }));
        }} className="text-xs text-foreground-muted hover:text-negative">Remove asset</button>
      </div>
    </div>
  );

  const renderPersonRead = (person: LifePerson, analysis: LifeResponse['analyses'][number] | undefined) => (
    <div key={person.id} className="rounded-md border border-border bg-background/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">{person.name || 'Unnamed person'}</span>
        <button type="button" onClick={() => openEditor(person.id)} className={EDIT_BUTTON}>Edit</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Annual income" value={formatCurrency(person.annualIncome)} />
        <Stat label="Existing coverage" value={formatCurrency(person.existingCoverage)} />
        <Stat label="Debts" value={formatCurrency(person.debts)} />
        <Stat label="Education goals" value={formatCurrency(person.educationGoals)} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric label="DIME gap" value={analysis ? formatCurrency(analysis.dimeGap) : 'Save'} />
        <Metric label="Survivor gap" value={analysis ? formatCurrency(analysis.survivorGap) : 'Save'} />
        <Metric label="Recommended coverage" value={analysis ? formatCurrency(analysis.recommendedCoverage) : 'Save'} tone={analysis && analysis.recommendedCoverage > 0 ? 'warning' : 'positive'} />
      </div>
    </div>
  );

  const renderPersonEdit = (person: LifePerson, analysis: LifeResponse['analyses'][number] | undefined) => (
    <div key={person.id} className="rounded-md border border-primary/40 bg-background/50 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground-secondary">Editing person</span>
        <button type="button" onClick={() => closeEditor(person.id)} className={EDIT_BUTTON}>Done</button>
      </div>
      <FieldGrid>
        <Field label="Household member">
          <select
            className={INPUT}
            aria-label="Household member"
            value={person.memberRole ?? ''}
            onChange={event => {
              const value = event.target.value;
              if (value === '') {
                updatePerson(person.id, { memberRole: null });
                return;
              }
              const member = householdMembers.find(item => item.role === value);
              if (!member) return;
              // Snapshot the name so the record still reads correctly if the
              // roster row is later renamed; the roster wins while it exists.
              updatePerson(person.id, {
                memberRole: member.role as HouseholdRole,
                name: member.name || HOUSEHOLD_ROLE_LABELS[member.role],
              });
            }}
          >
            <option value="">Not a household member — enter manually</option>
            {householdMembers
              .filter(member => member.role === person.memberRole
                || !life?.profile.people.some(item => item.id !== person.id && item.memberRole === member.role))
              .map(member => (
                <option key={member.role} value={member.role}>{memberLabel(member)}</option>
              ))}
          </select>
        </Field>
        {person.memberRole == null && (
          <Field label="Person (manual)"><input className={INPUT} value={person.name} onChange={event => updatePerson(person.id, { name: event.target.value })} /></Field>
        )}
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
      </FieldGrid>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Metric label="DIME gap" value={analysis ? formatCurrency(analysis.dimeGap) : 'Save'} />
        <Metric label="Survivor gap" value={analysis ? formatCurrency(analysis.survivorGap) : 'Save'} />
        <Metric label="Recommended coverage" value={analysis ? formatCurrency(analysis.recommendedCoverage) : 'Save'} tone={analysis && analysis.recommendedCoverage > 0 ? 'warning' : 'positive'} />
      </div>
      <button type="button" onClick={() => {
        if (!life) return;
        setLife({ ...life, profile: { people: life.profile.people.filter(item => item.id !== person.id) } });
        setDirty(current => ({ ...current, life: true }));
      }} className="mt-4 text-xs text-foreground-muted hover:text-negative">Remove person</button>
    </div>
  );

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      {/* Hidden shared file input for per-policy document uploads. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          const targetId = uploadTargetRef.current;
          event.target.value = '';
          uploadTargetRef.current = null;
          if (!file || !targetId || !insurance) return;
          const policy = insurance.profile.policies.find(item => item.id === targetId);
          if (policy) uploadDocumentForPolicy(policy, file);
        }}
      />
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
          <Panel
            title="Policies"
            description="Link declaration pages from the document vault; parse them with AI to prefill coverage details."
            action={<button type="button" onClick={addPolicy} className={SMALL_PRIMARY}>Add policy</button>}
          >
            {insurance.profile.policies.length === 0 ? <Empty>Add property, auto, umbrella, life or health coverage.</Empty> : (
              <div className="space-y-3">
                {insurance.profile.policies.map(policy =>
                  isEditing(policy.id) ? renderPolicyEdit(policy) : renderPolicyRead(policy))}
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
          <Panel title="Replacement schedule" description="Costs inflate to the expected replacement year and become Timeline events." action={<button type="button" onClick={addCapital} className={SMALL_PRIMARY}>Add asset</button>}>
            {capital.profile.assets.length === 0 ? <Empty>Add the roof, HVAC, water heater, appliances or other major systems.</Empty> : (
              <div className="space-y-3">
                {capital.profile.assets.map(asset => {
                  const calculated = capital.plan.rows.find(row => row.id === asset.id);
                  return isEditing(asset.id) ? renderCapitalEdit(asset, calculated) : renderCapitalRead(asset, calculated);
                })}
              </div>
            )}
          </Panel>
        </>
      )}

      {tab === 'life' && life && (
        <>
          <Panel title="Coverage needs" description="People come from your household members; only the financial inputs live here. Compares DIME with a survivor cash-flow model. This is planning support, not insurance advice." action={<button type="button" onClick={addPerson} className={SMALL_PRIMARY}>Add person</button>}>
            <p className="mb-3 text-xs text-foreground-muted">
              {householdMembers.length === 0
                ? <>No household members are configured yet. Add them in <Link href="/settings" className="text-primary underline-offset-2 hover:underline">Settings</Link> and names fill in here automatically; until then, enter people manually.</>
                : <>Names come from your household members — <Link href="/settings" className="text-primary underline-offset-2 hover:underline">change them in Settings</Link> and every planning pack follows.</>}
            </p>
            {life.profile.people.length === 0 ? <Empty>Add each income-earning or caregiving spouse.</Empty> : (
              <div className="space-y-4">
                {life.profile.people.map(person => {
                  const analysis = life.analyses.find(item => item.person.id === person.id);
                  return isEditing(person.id) ? renderPersonEdit(person, analysis) : renderPersonRead(person, analysis);
                })}
              </div>
            )}
          </Panel>
        </>
      )}
      <SaveBar saving={saving} dirty={dirty[tab]} onSave={save} onDiscard={discard} />
    </div>
  );
}
