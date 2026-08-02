'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import type { FuelProfile, MileageProfile, MileageTrip, MileageVehicle } from '@/lib/resilience/types';
import { Empty, Field, FieldGrid, INPUT, Metric, Panel, RecordCard, SaveBar, Tabs, TNUM } from '@/components/resilience/ui';

type Tab = 'log' | 'fuel';
const uid = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);

interface MileageResponse {
  profile: MileageProfile;
  summary: {
    totalMiles: number;
    deductibleMiles: number;
    deduction: number;
    rows: Array<MileageTrip & { rate: number; deduction: number }>;
    bySchedule: Array<{ schedule: string; miles: number; deduction: number }>;
  };
}

interface FuelResponse {
  profile: FuelProfile;
}

export default function MileagePage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('log');
  const [mileage, setMileage] = useState<MileageResponse | null>(null);
  const [fuel, setFuel] = useState<FuelResponse | null>(null);
  const [mileageDirty, setMileageDirty] = useState(false);
  const [fuelDirty, setFuelDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [token, setToken] = useState('');

  const load = async () => {
    const [mileageResponse, fuelResponse] = await Promise.all([
      fetch('/api/resilience/mileage', { cache: 'no-store' }),
      fetch('/api/resilience/fuel', { cache: 'no-store' }),
    ]);
    if (!mileageResponse.ok || !fuelResponse.ok) throw new Error('Request failed');
    setMileage(await mileageResponse.json());
    setFuel(await fuelResponse.json());
    setMileageDirty(false);
    setFuelDirty(false);
  };

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'fuel') setTab('fuel');
    load().catch(() => toast.error('Failed to load mileage log'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateMileage = (profile: MileageProfile) => {
    if (!mileage) return;
    setMileage({ ...mileage, profile });
    setMileageDirty(true);
  };

  const updateFuel = (profile: FuelProfile) => {
    if (!fuel) return;
    setFuel({ ...fuel, profile });
    setFuelDirty(true);
  };

  const addVehicle = () => {
    if (!mileage) return;
    const vehicle: MileageVehicle = { id: uid(), name: 'New vehicle', year: null, make: '', model: '', fuelTrackerVehicleId: null };
    updateMileage({ ...mileage.profile, vehicles: [...mileage.profile.vehicles, vehicle] });
  };

  const addTrip = () => {
    if (!mileage) return;
    if (mileage.profile.vehicles.length === 0) return toast.error('Add a vehicle first');
    const trip: MileageTrip = {
      id: uid(),
      date: today(),
      vehicleId: mileage.profile.vehicles[0].id,
      purpose: 'business',
      schedule: 'F',
      description: '',
      miles: 1,
      startOdometer: null,
      endOdometer: null,
    };
    updateMileage({ ...mileage.profile, trips: [trip, ...mileage.profile.trips] });
  };

  const updateVehicle = (id: string, patch: Partial<MileageVehicle>) => {
    if (!mileage) return;
    updateMileage({ ...mileage.profile, vehicles: mileage.profile.vehicles.map(vehicle => vehicle.id === id ? { ...vehicle, ...patch } : vehicle) });
  };

  const updateTrip = (id: string, patch: Partial<MileageTrip>) => {
    if (!mileage) return;
    updateMileage({ ...mileage.profile, trips: mileage.profile.trips.map(trip => {
      if (trip.id !== id) return trip;
      const next = { ...trip, ...patch };
      if (next.startOdometer != null && next.endOdometer != null && next.endOdometer >= next.startOdometer) {
        next.miles = next.endOdometer - next.startOdometer;
      }
      return next;
    }) });
  };

  const saveMileage = async () => {
    if (!mileage) return;
    setSaving(true);
    try {
      const response = await fetch('/api/resilience/mileage', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: mileage.profile }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Save failed');
      setMileage(json);
      setMileageDirty(false);
      toast.success('Mileage log saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const saveFuel = async () => {
    if (!fuel) return;
    setSaving(true);
    try {
      const response = await fetch('/api/resilience/fuel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: fuel.profile, token: token || undefined }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Save failed');
      setFuel(json);
      setToken('');
      setFuelDirty(false);
      toast.success('Fuel Tracker connection saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const syncFuel = async () => {
    setSyncing(true);
    try {
      if (fuelDirty) await saveFuel();
      const response = await fetch('/api/resilience/fuel-sync', { method: 'POST' });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Sync failed');
      setFuel({ profile: json.profile });
      toast.success(`Fuel Tracker synced: ${json.imported} imported, ${json.matched} matched`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Mileage & Fuel"
        subtitle="Substantiated mileage for Schedules C, E and F, plus evidence-matched Fuel Tracker imports."
        actions={
          tab === 'log'
            ? <button type="button" onClick={addTrip} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Log trip</button>
            : <button type="button" onClick={syncFuel} disabled={syncing} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50">{syncing ? 'Syncing…' : 'Sync now'}</button>
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'log', label: 'Mileage log' }, { value: 'fuel', label: 'Fuel Tracker' }]} />

      {tab === 'log' && mileage && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Metric label={`${new Date().getFullYear()} total miles`} value={mileage.summary.totalMiles.toFixed(1)} />
            <Metric label="Deductible miles" value={mileage.summary.deductibleMiles.toFixed(1)} />
            <Metric label="Estimated deduction" value={formatCurrency(mileage.summary.deduction)} tone="positive" />
          </div>
          <Panel title="Vehicles" action={<button type="button" onClick={addVehicle} className="text-sm text-primary">Add vehicle</button>}>
            {mileage.profile.vehicles.length === 0 ? <Empty>Add a vehicle before recording a trip.</Empty> : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {mileage.profile.vehicles.map(vehicle => (
                  <RecordCard
                    key={vehicle.id}
                    title={vehicle.name || 'Vehicle'}
                    removeLabel="Remove vehicle and trips"
                    onRemove={() => updateMileage({ ...mileage.profile, vehicles: mileage.profile.vehicles.filter(item => item.id !== vehicle.id), trips: mileage.profile.trips.filter(trip => trip.vehicleId !== vehicle.id) })}
                  >
                    <FieldGrid cols={2}>
                      <Field label="Vehicle" className="sm:col-span-2"><input className={INPUT} value={vehicle.name} onChange={event => updateVehicle(vehicle.id, { name: event.target.value })} /></Field>
                      <Field label="Year"><input type="number" className={`${INPUT} font-mono`} value={vehicle.year ?? ''} onChange={event => updateVehicle(vehicle.id, { year: event.target.value ? Number(event.target.value) : null })} /></Field>
                      <Field label="Make / model"><input className={INPUT} value={[vehicle.make, vehicle.model].filter(Boolean).join(' ')} onChange={event => updateVehicle(vehicle.id, { make: event.target.value, model: '' })} /></Field>
                    </FieldGrid>
                  </RecordCard>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="Trip log" description="2026 rates change on July 1: business 72.5¢ → 76¢; medical 20.5¢ → 23.5¢; charity remains 14¢.">
            {mileage.profile.trips.length === 0 ? <Empty>Use Log trip for thumb-first substantiation while the purpose is fresh.</Empty> : (
              <div className="space-y-2">
                {mileage.profile.trips.map(trip => {
                  const calculated = mileage.summary.rows.find(row => row.id === trip.id);
                  return (
                    <RecordCard
                      key={trip.id}
                      title={trip.description || 'Trip'}
                      removeLabel="Remove trip"
                      onRemove={() => updateMileage({ ...mileage.profile, trips: mileage.profile.trips.filter(item => item.id !== trip.id) })}
                    >
                      <FieldGrid>
                        <Field label="Date"><input type="date" className={`${INPUT} font-mono`} value={trip.date} onChange={event => updateTrip(trip.id, { date: event.target.value })} /></Field>
                        <Field label="Purpose / destination" className="sm:col-span-2 lg:col-span-2"><input className={INPUT} placeholder="Business purpose / destination" value={trip.description} onChange={event => updateTrip(trip.id, { description: event.target.value })} /></Field>
                        <Field label="Vehicle"><select className={INPUT} value={trip.vehicleId} onChange={event => updateTrip(trip.id, { vehicleId: event.target.value })}>{mileage.profile.vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.name}</option>)}</select></Field>
                        <Field label="Category"><select className={INPUT} value={trip.purpose} onChange={event => updateTrip(trip.id, { purpose: event.target.value as MileageTrip['purpose'] })}>{['business','medical','charity','personal'].map(purpose => <option key={purpose}>{purpose}</option>)}</select></Field>
                        <Field label="Schedule"><select className={INPUT} value={trip.schedule} onChange={event => updateTrip(trip.id, { schedule: event.target.value as MileageTrip['schedule'] })}>{['C','E','F','none'].map(schedule => <option key={schedule}>{schedule}</option>)}</select></Field>
                        <Field label="Miles"><div className="relative"><input type="number" min="0.01" step="0.1" className={`${INPUT} pr-10 font-mono`} value={trip.miles} onChange={event => updateTrip(trip.id, { miles: Number(event.target.value), startOdometer: null, endOdometer: null })} /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-foreground-muted">mi</span></div></Field>
                      </FieldGrid>
                      {calculated && <p className="text-xs text-foreground-secondary">{(calculated.rate * 100).toFixed(1)}¢/mile · <span className="font-mono text-positive" style={TNUM}>{formatCurrency(calculated.deduction)}</span> estimated deduction</p>}
                    </RecordCard>
                  );
                })}
              </div>
            )}
          </Panel>
          <SaveBar saving={saving} dirty={mileageDirty} onSave={saveMileage} />
        </>
      )}

      {tab === 'fuel' && fuel && (
        <>
          <Panel title="Fuel Tracker connection" description="Read-only bearer token; credentials are encrypted and never returned to the browser.">
            <FieldGrid>
              <Field label="Fuel Tracker URL"><input className={INPUT} placeholder="https://fuel.example.com" value={fuel.profile.baseUrl} onChange={event => updateFuel({ ...fuel.profile, baseUrl: event.target.value })} /></Field>
              <Field label={fuel.profile.hasToken ? 'Replace API token (optional)' : 'API token'}><input type="password" className={INPUT} value={token} onChange={event => { setToken(event.target.value); setFuelDirty(true); }} /></Field>
              <label className="flex items-end gap-2 pb-2.5 text-sm text-foreground-secondary"><input type="checkbox" checked={fuel.profile.enabled} onChange={event => updateFuel({ ...fuel.profile, enabled: event.target.checked })} /> Nightly sync enabled</label>
            </FieldGrid>
            <p className="mt-3 text-xs text-foreground-muted">Last sync: {fuel.profile.lastSyncAt ? new Date(fuel.profile.lastSyncAt).toLocaleString() : 'Never'}</p>
          </Panel>
          {fuel.profile.vehicles.length > 0 && mileage && (
            <Panel title="Vehicle mapping" description="Map each Fuel Tracker vehicle once; fill-ups inherit the mapping.">
              <div className="space-y-2">
                {fuel.profile.vehicles.map(vehicle => (
                  <div key={vehicle.sourceId} className="grid grid-cols-1 items-center gap-3 border-b border-border/60 py-2 last:border-0 sm:grid-cols-2">
                    <span className="text-sm text-foreground">{vehicle.year} {vehicle.make} {vehicle.model} · {vehicle.name}</span>
                    <select className={INPUT} value={vehicle.mappedVehicleId ?? ''} onChange={event => updateFuel({ ...fuel.profile, vehicles: fuel.profile.vehicles.map(item => item.sourceId === vehicle.sourceId ? { ...item, mappedVehicleId: event.target.value || null } : item) })}>
                      <option value="">Unmapped</option>
                      {mileage.profile.vehicles.map(local => <option key={local.id} value={local.id}>{local.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          <Panel title="Imported fill-ups" description="Exact amount/date candidates are linked to GnuCash transactions; uncertain records remain visible for review.">
            {fuel.profile.fillups.length === 0 ? <Empty>Save the connection, then run the first sync.</Empty> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[10px] uppercase tracking-wider text-foreground-muted"><tr><th className="pb-2">Date</th><th className="pb-2">Location</th><th className="pb-2 text-right">Gallons</th><th className="pb-2 text-right">$/gal</th><th className="pb-2 text-right">Total</th><th className="pb-2 text-right">Evidence</th></tr></thead>
                  <tbody>{fuel.profile.fillups.slice().reverse().slice(0, 200).map(fillup => (
                    <tr key={fillup.sourceId} className="border-t border-border/60">
                      <td className="py-2 font-mono">{fillup.date.slice(0, 10)}</td>
                      <td className="py-2 text-foreground-secondary">{fillup.location || '—'}</td>
                      <td className="py-2 text-right font-mono">{fillup.gallons.toFixed(3)}</td>
                      <td className="py-2 text-right font-mono">{formatCurrency(fillup.pricePerGallon)}</td>
                      <td className="py-2 text-right font-mono">{formatCurrency(fillup.totalCost)}</td>
                      <td className={`py-2 text-right text-xs ${fillup.matchStatus === 'matched' ? 'text-positive' : 'text-warning'}`}>{fillup.matchStatus === 'matched' ? 'Transaction linked' : 'Needs match'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Panel>
          <SaveBar saving={saving} dirty={fuelDirty} onSave={saveFuel} />
        </>
      )}
    </div>
  );
}
