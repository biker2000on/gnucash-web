'use client';

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { RentalProperty, RentalsProfile, RentalUnit } from '@/lib/resilience/types';
import { Empty, Field, FieldGrid, INPUT, Metric, Panel, SaveBar, TNUM } from '@/components/resilience/ui';

interface RentRollRow {
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitName: string;
  tenantName: string;
  monthlyRent: number;
  paidThisMonth: number;
  balance: number;
  dueDate: string;
  overdue: boolean;
  leaseEnd: string;
  daysToRenewal: number | null;
  securityDeposit: number;
}

interface RentalsResponse {
  profile: RentalsProfile;
  summary: {
    rows: RentRollRow[];
    monthlyScheduledRent: number;
    collectedThisMonth: number;
    outstanding: number;
    depositLiability: number;
  };
}

const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

function emptyUnit(): RentalUnit {
  const year = new Date().getFullYear();
  return {
    id: uid(),
    name: 'Unit 1',
    tenantName: '',
    tenantEmail: '',
    leaseStart: today(),
    leaseEnd: `${year + 1}-${today().slice(5)}`,
    monthlyRent: 0,
    rentDueDay: 1,
    securityDeposit: 0,
    lateFee: 0,
    annualEscalationPercent: 3,
    payments: [],
  };
}

export default function RentalsPage() {
  const toast = useToast();
  const [data, setData] = useState<RentalsResponse | null>(null);
  const [profile, setProfile] = useState<RentalsProfile>({ properties: [] });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paymentAmounts, setPaymentAmounts] = useState<Record<string, string>>({});

  const load = async () => {
    const response = await fetch('/api/resilience/rentals', { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to load rentals');
    const json = await response.json() as RentalsResponse;
    setData(json);
    setProfile(json.profile);
    setDirty(false);
  };

  useEffect(() => {
    load().catch(() => toast.error('Failed to load rental portfolio')).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (properties: RentalProperty[]) => {
    setProfile({ properties });
    setDirty(true);
  };

  const updateProperty = (propertyId: string, patch: Partial<RentalProperty>) => {
    change(profile.properties.map(property => property.id === propertyId ? { ...property, ...patch } : property));
  };

  const updateUnit = (propertyId: string, unitId: string, patch: Partial<RentalUnit>) => {
    change(profile.properties.map(property => property.id === propertyId
      ? { ...property, units: property.units.map(unit => unit.id === unitId ? { ...unit, ...patch } : unit) }
      : property));
  };

  const addPayment = (propertyId: string, unit: RentalUnit) => {
    const amount = Number(paymentAmounts[unit.id] || unit.monthlyRent);
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Enter a positive payment amount');
    updateUnit(propertyId, unit.id, {
      payments: [...unit.payments, {
        id: uid(),
        date: today(),
        amount,
        kind: 'rent',
        transactionGuid: null,
        note: null,
      }],
    });
    setPaymentAmounts(current => ({ ...current, [unit.id]: '' }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/resilience/rentals', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Save failed');
      setData(json as RentalsResponse);
      setProfile((json as RentalsResponse).profile);
      setDirty(false);
      toast.success('Rental portfolio saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const localSummary = useMemo(() => data?.summary, [data]);

  if (loading) return <div className="p-6 text-sm text-foreground-muted">Loading rent roll…</div>;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Rental Portfolio"
        subtitle="Leases, rent roll, security-deposit liabilities, collections and Schedule E links."
        actions={
          <button
            type="button"
            onClick={() => change([...profile.properties, {
              id: uid(),
              name: 'New property',
              address: '',
              scheduleEPropertyId: null,
              units: [emptyUnit()],
            }])}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover"
          >
            Add property
          </button>
        }
      />

      {localSummary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Scheduled monthly rent" value={formatCurrency(localSummary.monthlyScheduledRent)} />
          <Metric label="Collected this month" value={formatCurrency(localSummary.collectedThisMonth)} tone="positive" />
          <Metric label="Outstanding" value={formatCurrency(localSummary.outstanding)} tone={localSummary.outstanding > 0 ? 'negative' : 'positive'} />
          <Metric label="Deposit liability" value={formatCurrency(localSummary.depositLiability)} />
        </div>
      )}

      {localSummary && localSummary.rows.length > 0 && (
        <Panel title="Current rent roll" description="Saved data; save changes to refresh calculated balances.">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-foreground-muted">
                <tr>
                  <th className="pb-2">Property / unit</th>
                  <th className="pb-2">Tenant</th>
                  <th className="pb-2">Lease end</th>
                  <th className="pb-2 text-right">Rent</th>
                  <th className="pb-2 text-right">Paid</th>
                  <th className="pb-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {localSummary.rows.map(row => (
                  <tr key={row.unitId} className="border-t border-border/60">
                    <td className="py-2 text-foreground">{row.propertyName} · {row.unitName}</td>
                    <td className="py-2 text-foreground-secondary">{row.tenantName || 'Vacant'}</td>
                    <td className={`py-2 font-mono ${row.daysToRenewal != null && row.daysToRenewal <= 90 ? 'text-warning' : 'text-foreground-secondary'}`}>{row.leaseEnd}</td>
                    <td className="py-2 text-right font-mono" style={TNUM}>{formatCurrency(row.monthlyRent)}</td>
                    <td className="py-2 text-right font-mono text-positive" style={TNUM}>{formatCurrency(row.paidThisMonth)}</td>
                    <td className={`py-2 text-right font-mono ${row.overdue ? 'text-negative' : 'text-foreground'}`} style={TNUM}>{formatCurrency(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {profile.properties.length === 0 ? (
        <Empty>Add the first rental property to create a rent roll and lease timeline.</Empty>
      ) : profile.properties.map(property => (
        <Panel
          key={property.id}
          title={property.name}
          description={`${property.units.length} unit${property.units.length === 1 ? '' : 's'}`}
          action={
            <button
              type="button"
              onClick={() => change(profile.properties.filter(item => item.id !== property.id))}
              className="text-xs text-foreground-muted hover:text-negative"
            >
              Remove property
            </button>
          }
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Property name">
              <input className={INPUT} value={property.name} onChange={event => updateProperty(property.id, { name: event.target.value })} />
            </Field>
            <Field label="Address" className="md:col-span-2">
              <input className={INPUT} value={property.address} onChange={event => updateProperty(property.id, { address: event.target.value })} />
            </Field>
          </div>
          <div className="mt-4 space-y-3">
            {property.units.map(unit => (
              <div key={unit.id} className="rounded-md border border-border bg-background/50 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">{unit.name}</h3>
                  <button type="button" onClick={() => updateProperty(property.id, { units: property.units.filter(item => item.id !== unit.id) })} className="text-xs text-foreground-muted hover:text-negative">Remove unit</button>
                </div>
                <FieldGrid>
                  <Field label="Unit"><input className={INPUT} value={unit.name} onChange={event => updateUnit(property.id, unit.id, { name: event.target.value })} /></Field>
                  <Field label="Tenant"><input className={INPUT} value={unit.tenantName} onChange={event => updateUnit(property.id, unit.id, { tenantName: event.target.value })} /></Field>
                  <Field label="Tenant email"><input type="email" className={INPUT} value={unit.tenantEmail ?? ''} onChange={event => updateUnit(property.id, unit.id, { tenantEmail: event.target.value })} /></Field>
                  <Field label="Monthly rent"><input type="number" min="0" step="0.01" className={`${INPUT} font-mono`} value={unit.monthlyRent} onChange={event => updateUnit(property.id, unit.id, { monthlyRent: Number(event.target.value) })} /></Field>
                  <Field label="Lease start"><input type="date" className={`${INPUT} font-mono`} value={unit.leaseStart} onChange={event => updateUnit(property.id, unit.id, { leaseStart: event.target.value })} /></Field>
                  <Field label="Lease end"><input type="date" className={`${INPUT} font-mono`} value={unit.leaseEnd} onChange={event => updateUnit(property.id, unit.id, { leaseEnd: event.target.value })} /></Field>
                  <Field label="Rent due day"><input type="number" min="1" max="28" className={`${INPUT} font-mono`} value={unit.rentDueDay} onChange={event => updateUnit(property.id, unit.id, { rentDueDay: Number(event.target.value) })} /></Field>
                  <Field label="Annual escalation %"><input type="number" min="0" max="100" step="0.1" className={`${INPUT} font-mono`} value={unit.annualEscalationPercent} onChange={event => updateUnit(property.id, unit.id, { annualEscalationPercent: Number(event.target.value) })} /></Field>
                  <Field label="Security deposit"><input type="number" min="0" step="0.01" className={`${INPUT} font-mono`} value={unit.securityDeposit} onChange={event => updateUnit(property.id, unit.id, { securityDeposit: Number(event.target.value) })} /></Field>
                  <Field label="Late fee"><input type="number" min="0" step="0.01" className={`${INPUT} font-mono`} value={unit.lateFee} onChange={event => updateUnit(property.id, unit.id, { lateFee: Number(event.target.value) })} /></Field>
                  <Field label="Record rent payment" className="sm:col-span-2">
                    <div className="flex gap-2">
                      <input type="number" min="0" step="0.01" className={`${INPUT} font-mono`} placeholder={String(unit.monthlyRent)} value={paymentAmounts[unit.id] ?? ''} onChange={event => setPaymentAmounts(current => ({ ...current, [unit.id]: event.target.value }))} />
                      <button type="button" onClick={() => addPayment(property.id, unit)} className="shrink-0 rounded-md border border-border px-3 text-sm text-primary hover:border-primary">Record</button>
                    </div>
                  </Field>
                </FieldGrid>
                {unit.payments.length > 0 && (
                  <div className="mt-3 flex items-center justify-between text-xs text-foreground-muted">
                    <span>{unit.payments.length} payment record{unit.payments.length === 1 ? '' : 's'} · latest {unit.payments.at(-1)?.date}</span>
                    <a className="text-primary hover:underline" href={`/api/resilience/rental-statement/${unit.id}`}>Download tenant statement</a>
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => updateProperty(property.id, { units: [...property.units, emptyUnit()] })}
              className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-primary hover:border-primary"
            >
              Add unit
            </button>
          </div>
        </Panel>
      ))}
      <SaveBar saving={saving} dirty={dirty} onSave={save} />
    </div>
  );
}
