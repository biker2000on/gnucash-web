'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { EmailNotificationsSection } from '@/components/settings/EmailNotificationsSection';
import { BackupsSection } from '@/components/settings/BackupsSection';
import { TwoFactorSection } from '@/components/settings/TwoFactorSection';
import { ApiTokensSection } from '@/components/settings/ApiTokensSection';
import { WebhooksSection } from '@/components/settings/WebhooksSection';
import { ReportSchedulesSection } from '@/components/settings/ReportSchedulesSection';
import { ShareLinksSection } from '@/components/settings/ShareLinksSection';
import { CalendarFeedSection } from '@/components/settings/CalendarFeedSection';
import { EmailIngestSection } from '@/components/settings/EmailIngestSection';
import { PageHeader } from '@/components/ui/PageHeader';
import { useUserPreferences, type CostBasisMethod, type HomeScreen } from '@/contexts/UserPreferencesContext';
import type { DateFormat } from '@/lib/date-format';
import { BalanceReversal } from '@/lib/format';

// Group heading style for the settings page — matches the sidebar section labels.
const SETTINGS_GROUP_HEADING = 'text-[11px] font-semibold uppercase tracking-wider text-foreground-muted px-1';

const COST_BASIS_METHOD_OPTIONS: { value: CostBasisMethod; label: string; description: string }[] = [
  { value: 'fifo', label: 'FIFO', description: 'First-in, first-out. Oldest shares are used first.' },
  { value: 'lifo', label: 'LIFO', description: 'Last-in, first-out. Newest shares are used first.' },
  { value: 'average', label: 'Average', description: 'Weighted average cost of all shares.' },
];

interface ScheduleSettings {
  enabled: boolean;
  intervalHours: number;
  refreshTime: string; // HH:MM in UTC
}

interface IndexCoverage {
  earliestTransaction: string | null;
  indices: { symbol: string; name: string; count: number; earliest: string | null; latest: string | null }[];
  isUpToDate: boolean;
}

const INTERVAL_OPTIONS = [
  { value: 24, label: 'Daily' },
  { value: 12, label: 'Every 12 Hours' },
  { value: 6, label: 'Every 6 Hours' },
];

type EntityType =
  | 'household'
  | 'sole_prop'
  | 'llc_single'
  | 'llc_partnership'
  | 's_corp'
  | 'c_corp'
  | 'nonprofit_501c3';

const ENTITY_TYPE_OPTIONS: { value: EntityType; label: string }[] = [
  { value: 'household', label: 'Household' },
  { value: 'sole_prop', label: 'Sole Proprietorship' },
  { value: 'llc_single', label: 'Single-Member LLC' },
  { value: 'llc_partnership', label: 'Partnership LLC' },
  { value: 's_corp', label: 'S-Corp' },
  { value: 'c_corp', label: 'C-Corp' },
  { value: 'nonprofit_501c3', label: '501(c)(3) Nonprofit' },
];

const HOUSEHOLD_ROLE_OPTIONS = [
  { value: 'self', label: 'Self' },
  { value: 'spouse', label: 'Spouse' },
  { value: 'dependent', label: 'Child / Dependent' },
];

/** Full years of age from a YYYY-MM-DD birthday, or null when unset/invalid. */
function computeMemberAge(birthday: string): number | null {
  if (!birthday) return null;
  const [y, m, d] = birthday.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1;
  return age >= 0 ? age : null;
}

const BUSINESS_ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'officer', label: 'Officer' },
];

const NONPROFIT_ROLE_OPTIONS = [
  { value: 'officer', label: 'Officer / Director' },
];

/**
 * Human-readable noun for an entity type, used to label the settings section,
 * save button, and toast so a business/nonprofit book doesn't read as a
 * "Household". Households stay "Household"; 501(c)(3) reads as "Organization";
 * everything else is a "Business".
 */
function entityNoun(type: EntityType | undefined): string {
  if (!type || type === 'household') return 'Household';
  if (type === 'nonprofit_501c3') return 'Organization';
  return 'Business';
}

/** Heading for the members list, appropriate to the entity type. */
function entityMembersLabel(type: EntityType | undefined): string {
  if (!type || type === 'household') return 'Household Members';
  if (type === 'nonprofit_501c3') return 'Officers & Directors';
  return 'Owners & Officers';
}

/** Placeholder example name for the entity-name field. */
function entityNamePlaceholder(type: EntityType | undefined): string {
  if (!type || type === 'household') return 'Smith Household';
  if (type === 'nonprofit_501c3') return 'Community Bee Club';
  return 'Acme LLC';
}

interface EntityMemberForm {
  role: string;
  name: string;
  birthday: string; // YYYY-MM-DD or ''
  coveredByEmployerPlan: boolean;
  ownershipPercent: string; // raw input value
}

interface EntityProfileForm {
  entityType: EntityType;
  entityName: string;
  taxState: string;
  notes: string | null;
  members: EntityMemberForm[];
}

const BALANCE_REVERSAL_OPTIONS: { value: BalanceReversal; label: string; description: string }[] = [
  {
    value: 'none',
    label: 'None (Raw Values)',
    description: 'Show raw GnuCash accounting values. Income and liabilities appear negative.',
  },
  {
    value: 'credit',
    label: 'Credit Accounts',
    description: 'Reverse credit-balance accounts (Income, Liability, Equity). Income and liabilities appear positive.',
  },
  {
    value: 'income_expense',
    label: 'Income & Expense',
    description: 'Reverse both Income and Expense accounts. Both appear as positive values.',
  },
];

export default function SettingsPage() {
  const { success, error: showError } = useToast();
  const { defaultTaxRate, setDefaultTaxRate, dateFormat, setDateFormat, defaultLedgerMode, setDefaultLedgerMode, homeScreen, setHomeScreen, balanceReversal, setBalanceReversal, costBasisCarryOver, setCostBasisCarryOver, costBasisMethod, setCostBasisMethod } = useUserPreferences();

  const [schedule, setSchedule] = useState<ScheduleSettings>({ enabled: false, intervalHours: 24, refreshTime: '21:00' });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [indexCoverage, setIndexCoverage] = useState<IndexCoverage | null>(null);
  const [taxRateInput, setTaxRateInput] = useState('');
  const [simplefinSyncEnabled, setSimplefinSyncEnabled] = useState(false);
  const [simplefinConnected, setSimplefinConnected] = useState(false);
  const [savingBalance, setSavingBalance] = useState(false);
  const [entity, setEntity] = useState<EntityProfileForm | null>(null);
  const [savingEntity, setSavingEntity] = useState(false);

  // Household inventory opt-in (business books always have inventory).
  const [householdInventoryEnabled, setHouseholdInventoryEnabled] = useState(false);
  const [savingHouseholdInventory, setSavingHouseholdInventory] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/inventory/settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((s) => {
        if (!cancelled && s) setHouseholdInventoryEnabled(s.enabledForHousehold === true);
      })
      .catch(() => { /* leave disabled */ });
    return () => { cancelled = true; };
  }, []);
  const handleToggleHouseholdInventory = async (enabled: boolean) => {
    setSavingHouseholdInventory(true);
    const prev = householdInventoryEnabled;
    setHouseholdInventoryEnabled(enabled);
    try {
      const res = await fetch('/api/inventory/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledForHousehold: enabled }),
      });
      if (!res.ok) throw new Error('save failed');
      // Sidebar reacts without a refresh (same pattern as entity-updated).
      window.dispatchEvent(new CustomEvent('inventory-settings-updated'));
      success(enabled ? 'Inventory enabled for this book' : 'Inventory disabled for this book');
    } catch {
      setHouseholdInventoryEnabled(prev);
      showError('Failed to save inventory setting');
    } finally {
      setSavingHouseholdInventory(false);
    }
  };

  // Sync tax rate input from context (mount only)
  useEffect(() => {
    if (defaultTaxRate > 0) {
      setTaxRateInput((defaultTaxRate * 100).toString());
    } else {
      setTaxRateInput('');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load schedule settings
  useEffect(() => {
    async function loadSchedule() {
      try {
        const res = await fetch('/api/settings/schedules');
        if (res.ok) {
          const data = await res.json();
          setSchedule(data);
        }
      } catch (err) {
        console.error('Failed to load schedule settings:', err);
      } finally {
        setLoading(false);
      }
    }
    loadSchedule();
  }, []);

  // Check SimpleFin connection status (for sync toggle visibility)
  const fetchSimplefinStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/simplefin/status');
      if (res.ok) {
        const data = await res.json();
        setSimplefinConnected(data.connected);
        setSimplefinSyncEnabled(data.syncEnabled ?? false);
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchSimplefinStatus();
  }, [fetchSimplefinStatus]);

  // Load household & entity profile
  useEffect(() => {
    async function loadEntity() {
      try {
        const res = await fetch('/api/entity');
        if (res.ok) {
          const data = await res.json();
          setEntity({
            entityType: data.entityType ?? 'household',
            entityName: data.entityName ?? '',
            taxState: data.taxState ?? '',
            notes: data.notes ?? null,
            members: (data.members ?? []).map(
              (m: {
                role: string;
                name: string | null;
                birthday: string | null;
                coveredByEmployerPlan: boolean;
                ownershipPercent: number | null;
              }) => ({
                role: m.role,
                name: m.name ?? '',
                birthday: m.birthday ?? '',
                coveredByEmployerPlan: !!m.coveredByEmployerPlan,
                ownershipPercent: m.ownershipPercent != null ? String(m.ownershipPercent) : '',
              })
            ),
          });
        }
      } catch (err) {
        console.error('Failed to load entity profile:', err);
      }
    }
    loadEntity();
  }, []);

  // Load index coverage
  useEffect(() => {
    async function loadCoverage() {
      try {
        const res = await fetch('/api/investments/index-coverage');
        if (res.ok) {
          setIndexCoverage(await res.json());
        }
      } catch (err) {
        console.error('Failed to load index coverage:', err);
      }
    }
    loadCoverage();
  }, []);

  const handleBalanceReversalChange = async (value: BalanceReversal) => {
    setSavingBalance(true);
    try {
      await setBalanceReversal(value);
      success('Balance display preference saved');
    } catch {
      showError('Failed to save balance display preference');
    } finally {
      setSavingBalance(false);
    }
  };

  const handleScheduleToggle = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/settings/schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (!res.ok) throw new Error('Failed to update schedule');

      setSchedule((prev) => ({ ...prev, enabled }));
      success(`Automatic refresh ${enabled ? 'enabled' : 'disabled'}`);
    } catch {
      showError('Failed to update schedule setting');
    }
  };

  const updateSimplefinSync = async (enabled: boolean) => {
    try {
      await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { simplefin_sync_with_refresh: enabled ? 'true' : 'false' } }),
      });
      setSimplefinSyncEnabled(enabled);
      success(`SimpleFin sync ${enabled ? 'enabled' : 'disabled'} with price refresh`);
    } catch {
      showError('Failed to update SimpleFin sync setting');
    }
  };

  const handleIntervalChange = async (intervalHours: number) => {
    try {
      const res = await fetch('/api/settings/schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalHours }),
      });

      if (!res.ok) throw new Error('Failed to update interval');

      setSchedule((prev) => ({ ...prev, intervalHours }));
      success(`Refresh interval set to ${INTERVAL_OPTIONS.find((o) => o.value === intervalHours)?.label}`);
    } catch {
      showError('Failed to update refresh interval');
    }
  };

  // Convert UTC HH:MM to local HH:MM for the time input
  const utcToLocal = (utcTime: string): string => {
    const [h, m] = utcTime.split(':').map(Number);
    const d = new Date();
    d.setUTCHours(h, m, 0, 0);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // Convert local HH:MM to UTC HH:MM for storage
  const localToUtc = (localTime: string): string => {
    const [h, m] = localTime.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };

  const handleTimeChange = async (localTime: string) => {
    const utcTime = localToUtc(localTime);
    try {
      const res = await fetch('/api/settings/schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshTime: utcTime }),
      });

      if (!res.ok) throw new Error('Failed to update refresh time');

      setSchedule((prev) => ({ ...prev, refreshTime: utcTime }));
      success(`Refresh time set to ${localTime} (${utcTime} UTC)`);
    } catch {
      showError('Failed to update refresh time');
    }
  };

  const handleRefreshNow = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/settings/schedules/run-now', {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to trigger refresh');

      const data = await res.json();
      if (data.direct) {
        success(`${data.message} (${data.backfilled} new, ${data.gapsFilled} gaps filled)`);
      } else {
        success(data.message);
      }
    } catch {
      showError('Failed to start price refresh');
    } finally {
      setRefreshing(false);
    }
  };

  const handleRunPriceAudit = async () => {
    setAuditing(true);
    try {
      const res = await fetch('/api/prices/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ async: true }),
      });

      if (!res.ok) {
        const raw = await res.text();
        let parsed: { error?: string } | null = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // non-JSON response
        }
        throw new Error(parsed?.error || raw.slice(0, 200) || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.queued) {
        success(`Price audit queued (job ${data.jobId}) — watch the worker logs for progress.`);
      } else {
        success(
          `Price audit complete — stored ${data.stored}, audited ${data.audited}, failed ${data.failed}.`,
        );
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to start price audit');
    } finally {
      setAuditing(false);
    }
  };

  const handleBackfillIndices = async () => {
    setBackfilling(true);
    try {
      const res = await fetch('/api/investments/backfill-indices', {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to backfill indices');

      const data = await res.json();
      const resultSummary = data.results
        .map((r: { symbol: string; stored: number }) => `${r.symbol}: ${r.stored}`)
        .join(', ');
      success(`Backfilled ${data.totalStored} index prices (${resultSummary})`);

      // Refresh coverage info
      const coverageRes = await fetch('/api/investments/index-coverage');
      if (coverageRes.ok) {
        setIndexCoverage(await coverageRes.json());
      }
    } catch {
      showError('Failed to backfill index data');
    } finally {
      setBackfilling(false);
    }
  };

  const handleClearCache = async () => {
    setClearing(true);
    try {
      const res = await fetch('/api/settings/cache/clear', {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to clear cache');

      const data = await res.json();
      success(data.message);
    } catch {
      showError('Failed to clear cache');
    } finally {
      setClearing(false);
    }
  };

  const updateEntityMember = (index: number, patch: Partial<EntityMemberForm>) => {
    setEntity((prev) =>
      prev
        ? { ...prev, members: prev.members.map((m, i) => (i === index ? { ...m, ...patch } : m)) }
        : prev
    );
  };

  const handleAddEntityMember = (role: string) => {
    setEntity((prev) =>
      prev
        ? {
            ...prev,
            members: [
              ...prev.members,
              { role, name: '', birthday: '', coveredByEmployerPlan: false, ownershipPercent: '' },
            ],
          }
        : prev
    );
  };

  const handleRemoveEntityMember = (index: number) => {
    setEntity((prev) =>
      prev ? { ...prev, members: prev.members.filter((_, i) => i !== index) } : prev
    );
  };

  const handleSaveEntity = async () => {
    if (!entity) return;
    setSavingEntity(true);
    try {
      const res = await fetch('/api/entity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: entity.entityType,
          entityName: entity.entityName.trim() || null,
          taxState: entity.taxState.trim() || null,
          notes: entity.notes,
          members: entity.members.map((m, i) => {
            const pct = parseFloat(m.ownershipPercent);
            return {
              role: m.role,
              name: m.name.trim() || null,
              birthday: m.birthday || null,
              coveredByEmployerPlan: m.coveredByEmployerPlan,
              ownershipPercent: m.ownershipPercent !== '' && !isNaN(pct) ? pct : null,
              sortOrder: i,
            };
          }),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to save entity profile');
      }
      success(`${entityNoun(entity.entityType)} profile saved`);
      // Let the sidebar re-evaluate whether to show the Business nav group
      // without a page refresh (household ⇄ business/nonprofit toggles it).
      window.dispatchEvent(
        new CustomEvent('entity-updated', { detail: { entityType: entity.entityType } }),
      );
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to save entity profile');
    } finally {
      setSavingEntity(false);
    }
  };

  // One-line summaries shown while each section is collapsed
  const scheduleSummary = schedule.enabled
    ? `${INTERVAL_OPTIONS.find((o) => o.value === schedule.intervalHours)?.label ?? 'Daily'} at ${utcToLocal(schedule.refreshTime)}${simplefinConnected && simplefinSyncEnabled ? ' · SimpleFin sync' : ''}`
    : 'Disabled';
  const indexDataSummary = indexCoverage
    ? indexCoverage.isUpToDate
      ? 'Up to date'
      : 'Backfill available'
    : undefined;
  const taxRateSummary = taxRateInput ? `${taxRateInput}%` : 'Not set';
  const balanceDisplaySummary = `Reversal: ${BALANCE_REVERSAL_OPTIONS.find((o) => o.value === balanceReversal)?.label ?? balanceReversal}`;
  const costBasisSummary = costBasisCarryOver
    ? `Carry over · ${COST_BASIS_METHOD_OPTIONS.find((o) => o.value === costBasisMethod)?.label ?? costBasisMethod}`
    : 'No carry over';
  const displayPrefsSummary = `${dateFormat} · ${defaultLedgerMode === 'edit' ? 'Edit mode' : 'Read-only'} · ${homeScreen === 'accounts' ? 'Account Hierarchy' : 'Dashboard'}`;
  const entityTypeLabel = ENTITY_TYPE_OPTIONS.find((o) => o.value === entity?.entityType)?.label;
  const entitySummary = entity
    ? entity.entityType === 'household' || !entity.entityName.trim()
      ? `${entityTypeLabel} · ${entity.members.length} member${entity.members.length === 1 ? '' : 's'}`
      : `${entityTypeLabel} · ${entity.entityName.trim()}`
    : undefined;
  const entityRoleOptions =
    entity?.entityType === 'household'
      ? HOUSEHOLD_ROLE_OPTIONS
      : entity?.entityType === 'nonprofit_501c3'
        ? NONPROFIT_ROLE_OPTIONS
        : BUSINESS_ROLE_OPTIONS;
  const entitySectionTitle = entity ? `${entityNoun(entity.entityType)} profile` : 'Entity profile';

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <span className="text-foreground-secondary">Loading settings...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <PageHeader title="Settings" />

      {/* ── Book & Entity ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className={SETTINGS_GROUP_HEADING}>Book &amp; Entity</h2>

      {/* Entity profile (household / business / nonprofit) */}
      <CollapsibleConfigSection
        title={entitySectionTitle}
        summary={entitySummary}
        configured
        storageKey="settings.entityOpen"
      >
        {!entity ? (
          <div className="flex items-center gap-3 py-2">
            <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <span className="text-sm text-foreground-secondary">Loading entity profile...</span>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-foreground-muted">
              Describe who this book belongs to — a household, a business, or a nonprofit
              organization. Sets which features and reports apply (household tax estimator and
              contribution limits, or the business AR/AP suite).
            </p>

            {/* Entity Type */}
            <div className="space-y-2">
              <label className="block text-sm text-foreground-secondary">Entity Type</label>
              <select
                value={entity.entityType}
                onChange={(e) => setEntity({ ...entity, entityType: e.target.value as EntityType })}
                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
              >
                {ENTITY_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Entity Name + State */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 space-y-2">
                <label className="block text-sm text-foreground-secondary">Entity Name</label>
                <input
                  type="text"
                  value={entity.entityName}
                  onChange={(e) => setEntity({ ...entity, entityName: e.target.value })}
                  placeholder={entityNamePlaceholder(entity.entityType)}
                  className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                />
              </div>
              <div className="sm:w-32 space-y-2">
                <label className="block text-sm text-foreground-secondary">Tax State</label>
                <input
                  type="text"
                  value={entity.taxState}
                  onChange={(e) => setEntity({ ...entity, taxState: e.target.value.toUpperCase() })}
                  placeholder="CO"
                  maxLength={10}
                  className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                />
              </div>
            </div>

            {/* Members */}
            <div className="space-y-2">
              <label className="block text-sm text-foreground-secondary">
                {entityMembersLabel(entity.entityType)}
              </label>
              <div className="space-y-2">
                {entity.members.map((member, index) => {
                  const age = computeMemberAge(member.birthday);
                  return (
                  <div
                    key={index}
                    className="flex flex-wrap items-center gap-2 p-3 bg-background-tertiary rounded-lg"
                  >
                    <select
                      value={member.role}
                      onChange={(e) => updateEntityMember(index, { role: e.target.value })}
                      className="bg-input-bg border border-border rounded-lg px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
                      aria-label="Member role"
                    >
                      {!entityRoleOptions.some((o) => o.value === member.role) && (
                        <option value={member.role}>{member.role}</option>
                      )}
                      {entityRoleOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={member.name}
                      onChange={(e) => updateEntityMember(index, { name: e.target.value })}
                      placeholder="Name"
                      className="flex-1 min-w-32 bg-input-bg border border-border rounded-lg px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
                      aria-label="Member name"
                    />
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-foreground-secondary shrink-0">Birthday</label>
                      <input
                        type="date"
                        value={member.birthday}
                        onChange={(e) => updateEntityMember(index, { birthday: e.target.value })}
                        className="bg-input-bg border border-border rounded-lg px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
                        aria-label="Member birthday"
                      />
                      <span
                        className={`text-xs rounded-full px-2 py-0.5 shrink-0 border ${
                          age !== null
                            ? 'font-medium text-foreground-secondary bg-surface-elevated border-border'
                            : 'text-foreground-muted border-dashed border-border'
                        }`}
                      >
                        {age !== null ? `Age ${age}` : 'No birthday'}
                      </span>
                    </div>
                    {(member.role === 'self' || member.role === 'spouse') && (
                      <label className="flex items-center gap-1.5 cursor-pointer text-xs text-foreground-secondary">
                        <input
                          type="checkbox"
                          checked={member.coveredByEmployerPlan}
                          onChange={(e) =>
                            updateEntityMember(index, { coveredByEmployerPlan: e.target.checked })
                          }
                          className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
                        />
                        Covered by employer plan
                      </label>
                    )}
                    {member.role === 'owner' && (
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={member.ownershipPercent}
                          onChange={(e) =>
                            updateEntityMember(index, { ownershipPercent: e.target.value })
                          }
                          placeholder="100"
                          className="w-20 bg-input-bg border border-border rounded-lg px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
                          aria-label="Ownership percent"
                        />
                        <span className="text-xs text-foreground-muted">%</span>
                      </div>
                    )}
                    <button
                      onClick={() => handleRemoveEntityMember(index)}
                      className="ml-auto text-foreground-muted hover:text-rose-500 transition-colors p-1"
                      aria-label="Remove member"
                      title="Remove member"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  );
                })}
              </div>
              {entity.entityType === 'household' ? (
                <div className="flex flex-wrap gap-2">
                  {!entity.members.some((m) => m.role === 'self') && (
                    <button
                      onClick={() => handleAddEntityMember('self')}
                      className="text-sm text-primary hover:text-primary-hover border border-primary/40 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      + Add self
                    </button>
                  )}
                  {!entity.members.some((m) => m.role === 'spouse') && (
                    <button
                      onClick={() => handleAddEntityMember('spouse')}
                      className="text-sm text-primary hover:text-primary-hover border border-primary/40 rounded-lg px-3 py-1.5 transition-colors"
                    >
                      + Add spouse
                    </button>
                  )}
                  <button
                    onClick={() => handleAddEntityMember('dependent')}
                    className="text-sm text-primary hover:text-primary-hover border border-primary/40 rounded-lg px-3 py-1.5 transition-colors"
                  >
                    + Add child
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => handleAddEntityMember(entity.entityType === 'nonprofit_501c3' ? 'officer' : 'owner')}
                  className="text-sm text-primary hover:text-primary-hover transition-colors"
                >
                  + Add member
                </button>
              )}
            </div>

            {/* Save */}
            <button
              onClick={handleSaveEntity}
              disabled={savingEntity}
              className="w-full bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {savingEntity && (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              <span>{savingEntity ? 'Saving...' : `Save ${entityNoun(entity.entityType)} profile`}</span>
            </button>
          </div>
        )}
      </CollapsibleConfigSection>

      <CollapsibleConfigSection
        title="IRS Contribution Limits"
        summary="Annual limits for tax tools"
        configured
        storageKey="settings.irsLimitsOpen"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-foreground-muted">
            Review and update annual contribution limits used by the tax estimator and contribution tracking.
          </p>
          <Link
            href="/settings/limits"
            className="inline-flex items-center justify-center px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors shrink-0"
          >
            Open Limits Editor
          </Link>
        </div>
      </CollapsibleConfigSection>

      <CollapsibleConfigSection
        title="Categorization Rules"
        summary="Bank-import auto-categorization"
        configured
        storageKey="settings.categorizationRulesOpen"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-foreground-muted">
            Manage auto-categorization rules applied to bank-sync imports, with learned suggestions from your history.
          </p>
          <Link
            href="/settings/rules"
            className="inline-flex items-center justify-center px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors shrink-0"
          >
            Open Rules Editor
          </Link>
        </div>
      </CollapsibleConfigSection>

      {/* Inventory for household books (business books always have it) */}
      {entity && entity.entityType === 'household' && (
        <CollapsibleConfigSection
          title="Inventory Management"
          summary={householdInventoryEnabled ? 'Enabled' : 'Disabled'}
          configured
          storageKey="settings.householdInventoryOpen"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-foreground-muted">
              Track items, stock levels, and bills of materials in this household book.
              Adds an Inventory entry to the sidebar.
            </p>
            <label className="flex items-center gap-2 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={householdInventoryEnabled}
                onChange={(e) => handleToggleHouseholdInventory(e.target.checked)}
                disabled={savingHouseholdInventory}
                className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
              />
              <span className="text-sm text-foreground-secondary">Enabled</span>
            </label>
          </div>
        </CollapsibleConfigSection>
      )}
      </section>

      {/* ── Display & Preferences ─────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className={SETTINGS_GROUP_HEADING}>Display &amp; Preferences</h2>

      {/* Display Preferences */}
      <CollapsibleConfigSection
        title="Display Preferences"
        summary={displayPrefsSummary}
        configured
        storageKey="settings.displayPrefsOpen"
      >
        <div className="space-y-4">
          {/* Date Format */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Date Format</label>
            <select
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value as DateFormat)}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
            >
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              <option value="MM-DD-YYYY">MM-DD-YYYY</option>
            </select>
            <p className="text-xs text-foreground-muted">
              Format used for all date fields in the application.
            </p>
          </div>

          {/* Default Ledger Mode */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Default Ledger Mode</label>
            <select
              value={defaultLedgerMode}
              onChange={(e) => setDefaultLedgerMode(e.target.value as 'readonly' | 'edit')}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
            >
              <option value="readonly">Read-only</option>
              <option value="edit">Edit Mode</option>
            </select>
            <p className="text-xs text-foreground-muted">
              Whether account ledgers open in read-only or edit mode by default.
            </p>
          </div>

          {/* Home Screen */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Home Screen</label>
            <select
              value={homeScreen}
              onChange={(e) => setHomeScreen(e.target.value as HomeScreen)}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
            >
              <option value="dashboard">Dashboard</option>
              <option value="accounts">Account Hierarchy</option>
            </select>
            <p className="text-xs text-foreground-muted">
              The screen shown after login and when opening the app while signed in.
            </p>
          </div>
        </div>
      </CollapsibleConfigSection>

      {/* Balance Display */}
      <CollapsibleConfigSection
        title="Balance Display"
        summary={balanceDisplaySummary}
        configured
        storageKey="settings.balanceDisplayOpen"
      >
        <p className="text-sm text-foreground-muted mb-4">
          Choose how account balances are displayed throughout the app.
        </p>

        <div className="space-y-3">
          {BALANCE_REVERSAL_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`block p-4 rounded-xl border cursor-pointer transition-all ${
                balanceReversal === option.value
                  ? 'bg-primary/10 border-primary/50'
                  : 'bg-surface border-border hover:border-border-hover'
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="balanceReversal"
                  value={option.value}
                  checked={balanceReversal === option.value}
                  onChange={() => handleBalanceReversalChange(option.value)}
                  disabled={savingBalance}
                  className="mt-1 w-4 h-4 text-primary bg-background-tertiary border-border-hover focus:ring-primary/50"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{option.label}</span>
                    {savingBalance && balanceReversal === option.value && (
                      <div className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    )}
                  </div>
                  <p className="text-sm text-foreground-muted mt-1">{option.description}</p>
                </div>
              </div>
            </label>
          ))}
        </div>

        <details className="mt-4">
          <summary className="text-sm text-foreground-secondary cursor-pointer hover:text-foreground">
            Understanding Balance Reversal
          </summary>
          <div className="mt-2 text-sm text-foreground-muted space-y-2">
            <p>
              In double-entry accounting, some accounts naturally have credit balances (shown as negative in GnuCash):
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong className="text-foreground-secondary">Income</strong> - Money you earn appears negative</li>
              <li><strong className="text-foreground-secondary">Liabilities</strong> - Debts you owe appear negative</li>
              <li><strong className="text-foreground-secondary">Equity</strong> - Net worth appears negative</li>
            </ul>
            <p>
              The balance reversal setting displays these with positive values for easier reading,
              while maintaining proper accounting relationships.
            </p>
          </div>
        </details>
      </CollapsibleConfigSection>

      {/* Cost Basis */}
      <CollapsibleConfigSection
        title="Cost Basis"
        summary={costBasisSummary}
        configured
        storageKey="settings.costBasisOpen"
      >
        <p className="text-sm text-foreground-muted mb-4">
          Control how cost basis is calculated when shares are transferred between investment accounts.
        </p>

        <div className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={costBasisCarryOver}
              onChange={(e) => setCostBasisCarryOver(e.target.checked)}
              className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
            />
            <div>
              <span className="text-sm text-foreground">Carry over cost basis on transfers</span>
              <p className="text-xs text-foreground-muted mt-0.5">
                When shares are transferred between accounts, trace the original purchase cost instead of showing $0.
              </p>
            </div>
          </label>

          {costBasisCarryOver && (
            <div className="space-y-2 pl-7">
              <label className="block text-sm text-foreground-secondary">Cost Basis Method</label>
              <div className="space-y-2">
                {COST_BASIS_METHOD_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={`block p-3 rounded-lg border cursor-pointer transition-all ${
                      costBasisMethod === option.value
                        ? 'bg-primary/10 border-primary/50'
                        : 'bg-surface border-border hover:border-border-hover'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="costBasisMethod"
                        value={option.value}
                        checked={costBasisMethod === option.value}
                        onChange={() => setCostBasisMethod(option.value)}
                        className="mt-0.5 w-4 h-4 text-primary bg-background-tertiary border-border-hover focus:ring-primary/50"
                      />
                      <div className="flex-1">
                        <span className="font-medium text-foreground text-sm">{option.label}</span>
                        <p className="text-xs text-foreground-muted mt-0.5">{option.description}</p>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleConfigSection>

      {/* Tax Rate */}
      <CollapsibleConfigSection
        title="Default Tax Rate"
        summary={taxRateSummary}
        configured
        storageKey="settings.taxRateOpen"
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground-muted">
            Set a default tax rate to quickly apply to transaction amounts using the T keyboard shortcut.
          </p>

          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Default Tax Rate</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={taxRateInput}
                onChange={(e) => setTaxRateInput(e.target.value)}
                onBlur={() => {
                  const pct = parseFloat(taxRateInput);
                  if (!isNaN(pct) && pct >= 0 && pct <= 100) {
                    setDefaultTaxRate(pct / 100);
                  } else if (taxRateInput === '') {
                    setDefaultTaxRate(0);
                  }
                }}
                placeholder="0.00"
                className="w-32 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
              />
              <span className="text-sm text-foreground-muted">%</span>
            </div>
            <p className="text-xs text-foreground-muted">
              Press{' '}
              <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover text-xs">
                T
              </kbd>{' '}
              in amount fields to apply this tax rate to the current value.
            </p>
          </div>
        </div>
      </CollapsibleConfigSection>
      </section>

      {/* ── Prices & Market Data ──────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className={SETTINGS_GROUP_HEADING}>Prices &amp; Market Data</h2>

      <CollapsibleConfigSection
        title="Commodity Quote Settings"
        summary="Quote flags & price sources"
        configured
        storageKey="settings.commodityQuotesOpen"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-foreground-muted">
            Manage quote flags and price source configuration for all commodities.
          </p>
          <Link
            href="/settings/commodities"
            className="inline-flex items-center justify-center px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors shrink-0"
          >
            Open Commodity Settings
          </Link>
        </div>
      </CollapsibleConfigSection>

      {/* Price Refresh Schedule */}
      <CollapsibleConfigSection
        title="Price Refresh Schedule"
        summary={scheduleSummary}
        configured
        storageKey="settings.priceRefreshOpen"
      >
        <div className="space-y-4">
          {/* Enable/Disable Toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(e) => handleScheduleToggle(e.target.checked)}
              className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
            />
            <span className="text-sm text-foreground">Enable automatic price refresh</span>
          </label>

          {/* SimpleFin Sync Toggle - only show if connected */}
          {simplefinConnected && (
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={simplefinSyncEnabled}
                onChange={(e) => updateSimplefinSync(e.target.checked)}
                className="w-4 h-4 text-primary bg-background-tertiary border-border-hover rounded focus:ring-primary/50"
              />
              <span className="text-sm text-foreground">Sync SimpleFin transactions with each refresh</span>
            </label>
          )}

          {/* Refresh Frequency */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Refresh Frequency</label>
            <select
              value={schedule.intervalHours}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
              disabled={!schedule.enabled}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Refresh Time */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">
              Refresh Time
            </label>
            <input
              type="time"
              value={utcToLocal(schedule.refreshTime)}
              onChange={(e) => handleTimeChange(e.target.value)}
              disabled={!schedule.enabled}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <p className="text-xs text-foreground-muted">
              Schedule after US market close (4 PM ET) for complete daily prices.
            </p>
          </div>

          {/* Refresh Now Button */}
          <button
            onClick={handleRefreshNow}
            disabled={refreshing}
            className="w-full bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {refreshing && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            <span>{refreshing ? 'Refreshing...' : 'Refresh Now'}</span>
          </button>
        </div>
      </CollapsibleConfigSection>

      {/* Index Data */}
      <CollapsibleConfigSection
        title="Index Data"
        summary={indexDataSummary}
        configured
        storageKey="settings.indexDataOpen"
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground-muted">
            Historical price data for market indices (S&P 500, DJIA) used in performance charts.
          </p>

          {indexCoverage && (
            <div className="space-y-2">
              {indexCoverage.indices.map((idx) => (
                <div key={idx.symbol} className="flex items-center justify-between text-sm py-1.5 px-3 bg-background-tertiary rounded-lg">
                  <span className="font-medium text-foreground">{idx.name}</span>
                  <span className="text-foreground-secondary">
                    {idx.count > 0
                      ? `${idx.earliest} — ${idx.latest} (${Number(idx.count).toLocaleString()} prices)`
                      : 'No data'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {indexCoverage?.isUpToDate && (
            <p className="text-sm text-primary flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Index data is up to date
            </p>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleBackfillIndices}
              disabled={backfilling || (indexCoverage?.isUpToDate ?? false)}
              className="flex-1 bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {backfilling && (
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              <span>{backfilling ? 'Backfilling...' : 'Backfill Historical Index Data'}</span>
            </button>
            <button
              onClick={handleRunPriceAudit}
              disabled={auditing}
              title="Audits every commodity held in this book, fills gaps, and backfills history from Yahoo Finance. Runs in the background worker."
              className="flex-1 bg-surface-elevated hover:bg-surface-hover disabled:opacity-60 text-foreground border border-border font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {auditing && (
                <div className="w-4 h-4 border-2 border-foreground/30 border-t-foreground rounded-full animate-spin" />
              )}
              <span>{auditing ? 'Queuing…' : 'Run Full Price Audit'}</span>
            </button>
          </div>
        </div>
      </CollapsibleConfigSection>
      </section>

      {/* ── Notifications & Delivery ──────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className={SETTINGS_GROUP_HEADING}>Notifications &amp; Delivery</h2>
        <EmailNotificationsSection />
        <ReportSchedulesSection />
        <CalendarFeedSection />
      </section>

      {/* ── Integrations & Automation ─────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className={SETTINGS_GROUP_HEADING}>Integrations &amp; Automation</h2>
        <EmailIngestSection />
        <ApiTokensSection />
        <WebhooksSection />
        <ShareLinksSection />
      </section>

      {/* ── Security & Backups ────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className={SETTINGS_GROUP_HEADING}>Security &amp; Backups</h2>
        <TwoFactorSection />
        <BackupsSection />

      {/* Cache Management */}
      <CollapsibleConfigSection
        title="Cache Management"
        summary="Redis cache"
        configured
        storageKey="settings.cacheOpen"
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground-muted">
            Clears all cached dashboard calculations. Data will be recalculated on next visit.
          </p>

          <button
            onClick={handleClearCache}
            disabled={clearing}
            className="w-full bg-rose-600 hover:bg-rose-700 disabled:bg-rose-600/50 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {clearing && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            <span>{clearing ? 'Clearing...' : 'Clear All Caches'}</span>
          </button>
        </div>
      </CollapsibleConfigSection>
      </section>
    </div>
  );
}
