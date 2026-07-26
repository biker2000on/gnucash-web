import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/secure-config';
import { logAudit } from '@/lib/services/audit.service';
import { listItems } from '@/lib/services/home.service';
import { validateWebhookUrl } from '@/lib/webhooks';
import { createCalculationTrace } from '@/lib/provenance';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import {
  buildPersonalPriceIndex,
  calculateCapitalPlan,
  calculateCoverageGap,
  calculateLifeNeeds,
  calculateRentRoll,
  compareHealthPlans,
  parseReceiptPriceLines,
  summarizeMileage,
} from './core';
import type {
  CapitalProfile,
  FuelFillup,
  FuelProfile,
  HealthcareProfile,
  InsuranceProfile,
  LifeProfile,
  MileageProfile,
  RentalsProfile,
  ResilienceSection,
} from './types';
import type { FinancialActionCandidate } from '@/lib/financial-actions/types';
import type { EvidenceRef } from '@/lib/financial-actions/types';
import type { FinancialEvent } from '@/lib/money-timeline/types';

const id = z.string().min(1).max(100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite().min(0).max(1_000_000_000);
const percent = z.number().finite().min(0).max(100);

const rentalsSchema = z.object({
  properties: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300),
    scheduleEPropertyId: z.string().max(100).nullable().optional(),
    units: z.array(z.object({
      id,
      name: z.string().trim().min(1).max(120),
      tenantName: z.string().trim().max(160),
      tenantEmail: z.string().email().max(255).nullable().optional().or(z.literal('')),
      leaseStart: date,
      leaseEnd: date,
      monthlyRent: money,
      rentDueDay: z.number().int().min(1).max(28),
      securityDeposit: money,
      lateFee: money,
      annualEscalationPercent: percent,
      payments: z.array(z.object({
        id,
        date,
        amount: money,
        kind: z.enum(['rent', 'deposit', 'late_fee', 'credit']),
        transactionGuid: z.string().max(32).nullable().optional(),
        note: z.string().max(500).nullable().optional(),
      })).max(10_000),
    })).max(500),
  })).max(200),
});

const insuranceSchema = z.object({
  policies: z.array(z.object({
    id,
    type: z.enum(['home', 'renters', 'auto', 'umbrella', 'life', 'health', 'other']),
    provider: z.string().trim().min(1).max(160),
    policyNumber: z.string().trim().max(80),
    coveredEntity: z.string().trim().max(160),
    coverageLimit: money,
    deductible: money,
    annualPremium: money,
    renewalDate: date,
    sublimits: z.array(z.object({
      id,
      category: z.string().trim().min(1).max(120),
      limit: money,
    })).max(200),
    documentIds: z.array(z.number().int().positive()).max(200),
  })).max(500),
});

const capitalSchema = z.object({
  assets: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(160),
    category: z.string().trim().max(120),
    installedYear: z.number().int().min(1900).max(2300),
    expectedLifeYears: z.number().int().min(1).max(200),
    currentReplacementCost: money,
    inflationRate: z.number().finite().min(0).max(30),
    fundedAmount: money,
    linkedHomeItemId: z.number().int().positive().nullable().optional(),
  })).max(1000),
});

const lifeSchema = z.object({
  people: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(120),
    annualIncome: money,
    replacementYears: z.number().int().min(0).max(60),
    debts: money,
    educationGoals: money,
    finalExpenses: money,
    liquidAssets: money,
    existingCoverage: money,
    survivorAnnualIncome: money,
    survivorAnnualExpenses: money,
  })).max(20),
});

const healthcareSchema = z.object({
  currentPlanId: z.string().max(100).nullable().optional(),
  plans: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(160),
    annualPremium: money,
    familyDeductible: money,
    coinsurancePercent: percent,
    outOfPocketMax: money,
    employerHsaContribution: money,
    employeeHsaContribution: money,
    marginalTaxRate: percent,
    hsaEligible: z.boolean(),
  })).max(50),
  claims: z.array(z.object({
    id,
    date,
    member: z.string().trim().max(120),
    category: z.string().trim().max(120),
    allowedAmount: money,
  })).max(20_000),
});

const mileageSchema = z.object({
  vehicles: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(160),
    year: z.number().int().min(1886).max(2300).nullable().optional(),
    make: z.string().max(100).nullable().optional(),
    model: z.string().max(100).nullable().optional(),
    fuelTrackerVehicleId: z.string().max(100).nullable().optional(),
  })).max(200),
  trips: z.array(z.object({
    id,
    date,
    vehicleId: id,
    purpose: z.enum(['business', 'medical', 'charity', 'personal']),
    schedule: z.enum(['C', 'E', 'F', 'none']),
    description: z.string().trim().min(1).max(300),
    miles: z.number().finite().min(0.01).max(100_000),
    startOdometer: z.number().finite().min(0).nullable().optional(),
    endOdometer: z.number().finite().min(0).nullable().optional(),
  })).max(100_000),
});

const fuelSchema = z.object({
  baseUrl: z.string().trim().max(500),
  enabled: z.boolean(),
  hasToken: z.boolean().optional().default(false),
  lastSyncAt: z.string().datetime().nullable().optional(),
  vehicles: z.array(z.object({
    sourceId: id,
    name: z.string().max(160),
    year: z.number().int().nullable().optional(),
    make: z.string().max(100).nullable().optional(),
    model: z.string().max(100).nullable().optional(),
    mappedVehicleId: z.string().max(100).nullable().optional(),
  })).max(500),
  fillups: z.array(z.object({
    sourceId: id,
    sourceVehicleId: id,
    vehicleId: z.string().max(100).nullable().optional(),
    date: z.string().datetime(),
    gallons: z.number().finite().min(0),
    pricePerGallon: z.number().finite().min(0),
    totalCost: money,
    odometer: z.number().finite().min(0).nullable().optional(),
    mpg: z.number().finite().min(0).nullable().optional(),
    location: z.string().max(300).nullable().optional(),
    transactionGuid: z.string().max(32).nullable().optional(),
    matchStatus: z.enum(['unmatched', 'matched', 'ignored']),
  })).max(100_000),
});

const schemas = {
  rentals: rentalsSchema,
  insurance: insuranceSchema,
  capital: capitalSchema,
  life: lifeSchema,
  healthcare: healthcareSchema,
  mileage: mileageSchema,
  fuel: fuelSchema,
} satisfies Record<ResilienceSection, z.ZodType>;

const defaults = {
  rentals: { properties: [] },
  insurance: { policies: [] },
  capital: { assets: [] },
  life: { people: [] },
  healthcare: { currentPlanId: null, plans: [], claims: [] },
  mileage: { vehicles: [], trips: [] },
  fuel: { baseUrl: '', enabled: false, hasToken: false, lastSyncAt: null, vehicles: [], fillups: [] },
} satisfies Record<ResilienceSection, unknown>;

interface ProfileRow {
  data: unknown;
  secret_encrypted: string | null;
  updated_at: Date | string;
}

let ensurePromise: Promise<void> | null = null;

export function ensureResilienceTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS gnucash_web_resilience_profiles (
          book_guid VARCHAR(32) NOT NULL,
          section VARCHAR(32) NOT NULL,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          secret_encrypted TEXT,
          updated_by INTEGER,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
          PRIMARY KEY (book_guid, section)
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_resilience_profiles_book
          ON gnucash_web_resilience_profiles(book_guid)
      `);
    })().catch(error => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

export class ResilienceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResilienceValidationError';
  }
}

function parseSection<S extends ResilienceSection>(section: S, data: unknown): z.infer<(typeof schemas)[S]> {
  const result = schemas[section].safeParse(data);
  if (!result.success) {
    throw new ResilienceValidationError(result.error.issues[0]?.message ?? 'Invalid resilience profile');
  }
  return result.data as z.infer<(typeof schemas)[S]>;
}

export async function getResilienceProfile<S extends ResilienceSection>(
  bookGuid: string,
  section: S,
): Promise<z.infer<(typeof schemas)[S]>> {
  await ensureResilienceTable();
  const result = await query(
    'SELECT data, secret_encrypted, updated_at FROM gnucash_web_resilience_profiles WHERE book_guid = $1 AND section = $2',
    [bookGuid, section],
  );
  const row = result.rows[0] as ProfileRow | undefined;
  const parsed = parseSection(section, row?.data ?? defaults[section]);
  if (section === 'fuel') {
    return {
      ...(parsed as z.infer<typeof fuelSchema>),
      hasToken: Boolean(row?.secret_encrypted),
    } as z.infer<(typeof schemas)[S]>;
  }
  return parsed;
}

export async function saveResilienceProfile<S extends ResilienceSection>(input: {
  bookGuid: string;
  userId: number;
  section: S;
  data: unknown;
  token?: string | null;
}): Promise<z.infer<(typeof schemas)[S]>> {
  await ensureResilienceTable();
  const before = await getResilienceProfile(input.bookGuid, input.section);
  const parsed = parseSection(input.section, input.data);
  if (input.section === 'fuel') {
    const fuel = parsed as z.infer<typeof fuelSchema>;
    if (fuel.baseUrl) {
      const check = validateWebhookUrl(fuel.baseUrl, { allowInternal: true });
      if (!check.ok) throw new ResilienceValidationError(check.error ?? 'Invalid Fuel Tracker URL');
    }
  }
  const existing = await query(
    'SELECT secret_encrypted FROM gnucash_web_resilience_profiles WHERE book_guid = $1 AND section = $2',
    [input.bookGuid, input.section],
  );
  const previousSecret = (existing.rows[0] as { secret_encrypted?: string } | undefined)?.secret_encrypted ?? null;
  const secret = input.section === 'fuel' && input.token?.trim()
    ? encryptSecret(input.token.trim())
    : previousSecret;
  if (input.section === 'fuel' && (parsed as z.infer<typeof fuelSchema>).enabled && !secret) {
    throw new ResilienceValidationError('An API token is required before enabling Fuel Tracker sync');
  }
  const stored = input.section === 'fuel'
    ? { ...(parsed as z.infer<typeof fuelSchema>), hasToken: Boolean(secret) }
    : parsed;
  await query(
    `INSERT INTO gnucash_web_resilience_profiles
       (book_guid, section, data, secret_encrypted, updated_by)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (book_guid, section) DO UPDATE SET
       data = EXCLUDED.data,
       secret_encrypted = EXCLUDED.secret_encrypted,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [input.bookGuid, input.section, JSON.stringify(stored), secret, input.userId],
  );
  const after = await getResilienceProfile(input.bookGuid, input.section);
  await logAudit(
    'UPDATE',
    'RESILIENCE',
    input.bookGuid,
    before,
    after,
    { bookGuid: input.bookGuid, userId: input.userId },
  );
  return after;
}

export async function getResilienceSection(bookGuid: string, section: ResilienceSection) {
  const profile = await getResilienceProfile(bookGuid, section);
  if (section === 'rentals') {
    return { profile, summary: calculateRentRoll((profile as RentalsProfile).properties) };
  }
  if (section === 'insurance') {
    const items = await listItems(bookGuid);
    return {
      profile,
      inventoryCount: items.length,
      analysis: calculateCoverageGap(
        (profile as InsuranceProfile).policies,
        items.map(item => ({ category: item.category, estValue: item.estValue })),
      ),
    };
  }
  if (section === 'capital') {
    return { profile, plan: calculateCapitalPlan((profile as CapitalProfile).assets) };
  }
  if (section === 'life') {
    return { profile, analyses: (profile as LifeProfile).people.map(calculateLifeNeeds) };
  }
  if (section === 'healthcare') {
    const health = profile as HealthcareProfile;
    return { profile, comparison: compareHealthPlans(health.plans, health.claims) };
  }
  if (section === 'mileage') {
    return {
      profile,
      summary: summarizeMileage((profile as MileageProfile).trips, new Date().getFullYear()),
    };
  }
  return { profile };
}

interface FuelTrackerVehicle {
  id: string;
  name: string;
  year?: number | null;
  make?: string | null;
  model?: string | null;
}

interface FuelTrackerFillup {
  id: string;
  date: string;
  gallons: number;
  pricePerGallon: number;
  totalCost: number;
  odometer?: number | null;
  mpg?: number | null;
  city?: string | null;
  state?: string | null;
  vehicleId: string;
}

async function fuelFetch<T>(baseUrl: string, token: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, `${baseUrl.replace(/\/+$/, '')}/`), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Fuel Tracker returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function matchFillupsToTransactions(
  fillups: FuelFillup[],
  bookAccountGuids: string[],
): Promise<FuelFillup[]> {
  if (fillups.length === 0 || bookAccountGuids.length === 0) return fillups;
  const start = fillups.map(item => item.date.slice(0, 10)).sort()[0];
  const end = fillups.map(item => item.date.slice(0, 10)).sort().at(-1)!;
  const result = await query(
    `SELECT t.guid, t.post_date::date::text AS post_date, t.description,
            MAX(ABS(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric))::float8 AS amount
       FROM transactions t
       JOIN splits s ON s.tx_guid = t.guid
      WHERE s.account_guid = ANY($1::text[])
        AND t.post_date >= $2::date - INTERVAL '2 days'
        AND t.post_date < $3::date + INTERVAL '3 days'
      GROUP BY t.guid, t.post_date, t.description`,
    [bookAccountGuids, start, end],
  );
  const used = new Set<string>();
  return fillups.map(fillup => {
    if (fillup.matchStatus !== 'unmatched') return fillup;
    const fillDate = new Date(fillup.date);
    const match = (result.rows as Array<{ guid: string; post_date: string; description: string; amount: number }>)
      .filter(row => !used.has(row.guid))
      .filter(row => Math.abs(Number(row.amount) - fillup.totalCost) <= 0.02)
      .sort((a, b) => {
        const aDays = Math.abs(new Date(`${a.post_date}T12:00:00Z`).getTime() - fillDate.getTime());
        const bDays = Math.abs(new Date(`${b.post_date}T12:00:00Z`).getTime() - fillDate.getTime());
        const aFuel = /fuel|gas|shell|exxon|bp|chevron|speedway/i.test(a.description) ? -1 : 0;
        const bFuel = /fuel|gas|shell|exxon|bp|chevron|speedway/i.test(b.description) ? -1 : 0;
        return aFuel - bFuel || aDays - bDays;
      })[0];
    if (!match) return fillup;
    used.add(match.guid);
    return { ...fillup, transactionGuid: match.guid, matchStatus: 'matched' as const };
  });
}

export async function syncFuelTracker(input: {
  bookGuid: string;
  userId: number;
  bookAccountGuids: string[];
}) {
  await ensureResilienceTable();
  const result = await query(
    'SELECT data, secret_encrypted FROM gnucash_web_resilience_profiles WHERE book_guid = $1 AND section = $2',
    [input.bookGuid, 'fuel'],
  );
  const row = result.rows[0] as ProfileRow | undefined;
  const profile = parseSection('fuel', row?.data ?? defaults.fuel) as FuelProfile;
  const token = decryptSecret(row?.secret_encrypted ?? null);
  if (!profile.enabled || !profile.baseUrl || !token) {
    throw new Error('Configure and enable the Fuel Tracker connection first');
  }
  const vehiclePayload = await fuelFetch<{ vehicles: FuelTrackerVehicle[] }>(
    profile.baseUrl,
    token,
    '/api/v1/vehicles',
  );
  const existingMappings = new Map(profile.vehicles.map(vehicle => [vehicle.sourceId, vehicle.mappedVehicleId]));
  const vehicles = vehiclePayload.vehicles.map(vehicle => ({
    sourceId: vehicle.id,
    name: vehicle.name,
    year: vehicle.year ?? null,
    make: vehicle.make ?? null,
    model: vehicle.model ?? null,
    mappedVehicleId: existingMappings.get(vehicle.id) ?? null,
  }));
  const existingFillups = new Map(profile.fillups.map(fillup => [fillup.sourceId, fillup]));
  let cursor: string | null = null;
  let imported = 0;
  do {
    const params = new URLSearchParams({ limit: '500' });
    if (profile.lastSyncAt) params.set('updatedSince', profile.lastSyncAt);
    if (cursor) params.set('cursor', cursor);
    const payload: { fillups: FuelTrackerFillup[]; nextCursor: string | null } = await fuelFetch(
      profile.baseUrl,
      token,
      `/api/v1/fillups?${params}`,
    );
    for (const source of payload.fillups) {
      const prior = existingFillups.get(source.id);
      if (!prior) imported++;
      existingFillups.set(source.id, {
        sourceId: source.id,
        sourceVehicleId: source.vehicleId,
        vehicleId: vehicles.find(vehicle => vehicle.sourceId === source.vehicleId)?.mappedVehicleId ?? null,
        date: source.date,
        gallons: source.gallons,
        pricePerGallon: source.pricePerGallon,
        totalCost: source.totalCost,
        odometer: source.odometer ?? null,
        mpg: source.mpg ?? null,
        location: [source.city, source.state].filter(Boolean).join(', ') || null,
        transactionGuid: prior?.transactionGuid ?? null,
        matchStatus: prior?.matchStatus ?? 'unmatched',
      });
    }
    cursor = payload.nextCursor;
  } while (cursor);
  const fillups = await matchFillupsToTransactions([...existingFillups.values()], input.bookAccountGuids);
  const saved = await saveResilienceProfile({
    bookGuid: input.bookGuid,
    userId: input.userId,
    section: 'fuel',
    data: {
      ...profile,
      hasToken: true,
      vehicles,
      fillups,
      lastSyncAt: new Date().toISOString(),
    },
  });
  return {
    profile: saved,
    imported,
    total: fillups.length,
    matched: fillups.filter(fillup => fillup.matchStatus === 'matched').length,
  };
}

export async function syncEnabledFuelTrackers() {
  await ensureResilienceTable();
  const result = await query(
    `SELECT book_guid, COALESCE(updated_by, 1) AS user_id
       FROM gnucash_web_resilience_profiles
      WHERE section = 'fuel'
        AND COALESCE((data->>'enabled')::boolean, FALSE) = TRUE
        AND secret_encrypted IS NOT NULL`,
  );
  const outcomes: Array<{ bookGuid: string; imported: number; matched: number; error?: string }> = [];
  for (const row of result.rows as Array<{ book_guid: string; user_id: number }>) {
    try {
      const synced = await syncFuelTracker({
        bookGuid: row.book_guid,
        userId: Number(row.user_id),
        bookAccountGuids: await getAccountGuidsForBook(row.book_guid),
      });
      outcomes.push({ bookGuid: row.book_guid, imported: synced.imported, matched: synced.matched });
    } catch (error) {
      outcomes.push({
        bookGuid: row.book_guid,
        imported: 0,
        matched: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

export async function loadPersonalPriceIndex(bookGuid: string) {
  const result = await query(
    `SELECT r.id, COALESCE(t.post_date::date, r.created_at::date)::text AS receipt_date,
            t.description AS merchant, r.ocr_text
       FROM gnucash_web_receipts r
       LEFT JOIN transactions t ON t.guid = r.transaction_guid
      WHERE r.book_guid = $1 AND r.ocr_status = 'completed' AND r.ocr_text IS NOT NULL
      ORDER BY COALESCE(t.post_date, r.created_at)`,
    [bookGuid],
  );
  const observations = (result.rows as Array<{
    id: number;
    receipt_date: string;
    merchant: string | null;
    ocr_text: string;
  }>).flatMap(row => parseReceiptPriceLines({
    receiptId: row.id,
    date: row.receipt_date,
    merchant: row.merchant,
    text: row.ocr_text,
  }));
  return {
    ...buildPersonalPriceIndex(observations),
    observations: observations.length,
    blsBenchmarks: await loadBlsCpiBenchmarks(),
  };
}

interface BlsObservation {
  year: string;
  period: string;
  value: string;
}

const BLS_SERIES = [
  { id: 'CUUR0000SA0', label: 'All items' },
  { id: 'CUUR0000SAF11', label: 'Food at home' },
  { id: 'CUUR0000SETB01', label: 'Motor fuel' },
  { id: 'CUUR0000SAM2', label: 'Medical care' },
  { id: 'CUUR0000SAH1', label: 'Shelter' },
] as const;

async function loadBlsCpiBenchmarks(): Promise<Array<{
  id: string;
  label: string;
  latestPeriod: string;
  yearOverYearPercent: number;
}>> {
  try {
    const year = new Date().getUTCFullYear();
    const response = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seriesid: BLS_SERIES.map(series => series.id),
        startyear: String(year - 1),
        endyear: String(year),
      }),
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    if (!response.ok) return [];
    const payload = await response.json() as {
      Results?: { series?: Array<{ seriesID: string; data: BlsObservation[] }> };
    };
    return (payload.Results?.series ?? []).flatMap(series => {
      const monthly = series.data.filter(item => /^M(0[1-9]|1[0-2])$/.test(item.period));
      const latest = monthly[0];
      if (!latest) return [];
      const prior = monthly.find(item => item.year === String(Number(latest.year) - 1) && item.period === latest.period);
      if (!prior || Number(prior.value) === 0) return [];
      const definition = BLS_SERIES.find(item => item.id === series.seriesID);
      return [{
        id: series.seriesID,
        label: definition?.label ?? series.seriesID,
        latestPeriod: `${latest.year}-${latest.period.slice(1)}`,
        yearOverYearPercent: Math.round((((Number(latest.value) / Number(prior.value)) - 1) * 100) * 100) / 100,
      }];
    });
  } catch {
    return [];
  }
}

function action(input: Omit<FinancialActionCandidate, 'trace'> & {
  result?: number;
  formula?: string;
  assumptions?: string[];
  evidence?: EvidenceRef[];
}): FinancialActionCandidate {
  const { result, formula, assumptions, evidence, ...candidate } = input;
  return {
    ...candidate,
    trace: createCalculationTrace({
      namespace: `resilience:${candidate.origin}`,
      identity: { stableKey: candidate.stableKey },
      title: candidate.title,
      summary: candidate.summary,
      formula,
      result: result ?? candidate.impact?.high ?? 1,
      unit: candidate.impact ? 'currency' : 'count',
      assumptions,
      evidence,
      metadata: candidate.metadata,
    }),
  };
}

export async function loadResilienceActions(bookGuid: string): Promise<FinancialActionCandidate[]> {
  const [rentals, insurance, capital, life, healthcare, fuel, items] = await Promise.all([
    getResilienceProfile(bookGuid, 'rentals'),
    getResilienceProfile(bookGuid, 'insurance'),
    getResilienceProfile(bookGuid, 'capital'),
    getResilienceProfile(bookGuid, 'life'),
    getResilienceProfile(bookGuid, 'healthcare'),
    getResilienceProfile(bookGuid, 'fuel'),
    listItems(bookGuid),
  ]);
  const actions: FinancialActionCandidate[] = [];
  const rentRoll = calculateRentRoll((rentals as RentalsProfile).properties);
  for (const row of rentRoll.rows) {
    if (row.overdue) {
      actions.push(action({
        stableKey: `rental-overdue:${row.unitId}:${row.dueDate}`,
        lane: 'do',
        origin: 'rental',
        sourceId: row.unitId,
        severity: 'critical',
        title: `Collect overdue rent from ${row.tenantName || row.unitName}`,
        summary: `${row.balance.toFixed(2)} remains due for ${row.propertyName} — ${row.unitName}.`,
        dueDate: row.dueDate,
        impact: { low: row.balance, high: row.balance, period: 'one_time' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Open rent roll', kind: 'link', href: '/business/rentals', primary: true }],
        result: row.balance,
        evidence: [{ kind: 'lease', id: row.unitId, label: `${row.propertyName} — ${row.unitName}`, source: 'manual', href: '/business/rentals', verified: true }],
      }));
    }
    if (row.daysToRenewal != null && row.daysToRenewal >= 0 && row.daysToRenewal <= 90) {
      actions.push(action({
        stableKey: `lease-renewal:${row.unitId}:${row.leaseEnd}`,
        lane: 'decide',
        origin: 'rental',
        sourceId: row.unitId,
        severity: row.daysToRenewal <= 30 ? 'warning' : 'info',
        title: `Decide lease renewal for ${row.tenantName || row.unitName}`,
        summary: `The lease ends ${row.leaseEnd}; review rent escalation and renewal terms.`,
        dueDate: row.leaseEnd,
        impact: { low: row.monthlyRent, high: row.monthlyRent * 12, period: 'annual' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Review lease', kind: 'link', href: '/business/rentals', primary: true }],
        evidence: [{ kind: 'lease', id: row.unitId, label: `${row.propertyName} — ${row.unitName}`, source: 'manual', href: '/business/rentals', verified: true }],
      }));
    }
  }
  const coverage = calculateCoverageGap(
    (insurance as InsuranceProfile).policies,
    items.map(item => ({ category: item.category, estValue: item.estValue })),
  );
  if (coverage.gap > 0) {
    actions.push(action({
      stableKey: 'insurance-inventory-gap',
      lane: 'decide',
      origin: 'resilience',
      sourceId: 'home-inventory',
      severity: 'critical',
      title: 'Close the home contents coverage gap',
      summary: `Documented replacement value exceeds property coverage by ${coverage.gap.toFixed(2)}.`,
      dueDate: null,
      impact: { low: coverage.gap, high: coverage.gap, period: 'one_time' },
      confidence: 0.95,
      operations: [{ id: 'open', label: 'Review coverage', kind: 'link', href: '/home/protection', primary: true }],
      formula: 'max(0, inventory replacement value - property coverage limit)',
      assumptions: ['Home inventory estimates represent replacement value.'],
      evidence: [{ kind: 'home_item', id: 'home-inventory', label: `${items.length} documented home items`, source: 'manual', href: '/home/inventory', verified: false }],
    }));
  }
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  for (const policy of (insurance as InsuranceProfile).policies) {
    const days = Math.ceil((new Date(`${policy.renewalDate}T12:00:00Z`).getTime() - now.getTime()) / 86_400_000);
    if (days >= 0 && days <= 60) {
      actions.push(action({
        stableKey: `policy-renewal:${policy.id}:${policy.renewalDate}`,
        lane: 'decide',
        origin: 'resilience',
        sourceId: policy.id,
        severity: days <= 14 ? 'warning' : 'info',
        title: `Review ${policy.type} policy renewal`,
        summary: `${policy.provider} renews on ${policy.renewalDate} at ${policy.annualPremium.toFixed(2)} per year.`,
        dueDate: policy.renewalDate,
        impact: { low: policy.annualPremium, high: policy.annualPremium, period: 'annual' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Review policy', kind: 'link', href: '/home/protection', primary: true }],
        evidence: [{ kind: 'policy', id: policy.id, label: `${policy.provider} ${policy.type} policy`, source: 'manual', href: '/home/protection', verified: false }],
      }));
    }
  }
  const capitalPlan = calculateCapitalPlan((capital as CapitalProfile).assets);
  for (const row of capitalPlan.rows.filter(asset => asset.overdue || asset.yearsRemaining <= 2)) {
    actions.push(action({
      stableKey: `capital-replacement:${row.id}:${row.replacementYear}`,
      lane: 'decide',
      origin: 'resilience',
      sourceId: row.id,
      severity: row.overdue ? 'critical' : 'warning',
      title: `${row.overdue ? 'Replace or inspect' : 'Fund'} ${row.name}`,
      summary: `${row.futureCost.toFixed(2)} projected replacement cost; ${row.fundingGap.toFixed(2)} remains unfunded.`,
      dueDate: `${Math.max(now.getUTCFullYear(), row.replacementYear)}-12-31`,
      impact: { low: row.fundingGap, high: row.futureCost, period: 'one_time' },
      confidence: 0.85,
      operations: [{ id: 'open', label: 'Open capital plan', kind: 'link', href: '/home/protection?tab=capital', primary: true }],
      formula: 'current cost × (1 + inflation rate) ^ years remaining - funded amount',
      evidence: [{ kind: 'home_item', id: row.id, label: row.name, source: 'manual', href: '/home/protection?tab=capital', verified: false }],
    }));
  }
  for (const person of (life as LifeProfile).people.map(calculateLifeNeeds).filter(row => row.recommendedCoverage > 0)) {
    actions.push(action({
      stableKey: `life-coverage:${person.person.id}`,
      lane: 'decide',
      origin: 'resilience',
      sourceId: person.person.id,
      severity: 'warning',
      title: `Review life coverage for ${person.person.name}`,
      summary: `The larger of DIME and survivor cash-flow models shows a ${person.recommendedCoverage.toFixed(2)} gap.`,
      dueDate: null,
      impact: { low: Math.min(person.dimeGap, person.survivorGap), high: person.recommendedCoverage, period: 'lifetime' },
      confidence: 0.8,
      operations: [{ id: 'open', label: 'Review needs analysis', kind: 'link', href: '/home/protection?tab=life', primary: true }],
      assumptions: ['Coverage need is a planning estimate, not insurance advice.'],
      evidence: [{ kind: 'assumption', id: person.person.id, label: `${person.person.name} planning inputs`, source: 'manual', href: '/home/protection?tab=life', verified: false }],
    }));
  }
  const comparisons = compareHealthPlans((healthcare as HealthcareProfile).plans, (healthcare as HealthcareProfile).claims);
  const currentId = (healthcare as HealthcareProfile).currentPlanId;
  const current = comparisons.find(row => row.plan.id === currentId);
  if (current && comparisons[0] && current.netAnnualCost - comparisons[0].netAnnualCost > 100) {
    const savings = current.netAnnualCost - comparisons[0].netAnnualCost;
    actions.push(action({
      stableKey: `health-plan-opportunity:${current.plan.id}:${comparisons[0].plan.id}`,
      lane: 'decide',
      origin: 'resilience',
      sourceId: comparisons[0].plan.id,
      severity: 'info',
      title: `Compare ${comparisons[0].plan.name} during open enrollment`,
      summary: `Replaying entered claims estimates ${savings.toFixed(2)} lower annual cost than ${current.plan.name}.`,
      dueDate: null,
      impact: { low: savings, high: savings, period: 'annual' },
      confidence: 0.8,
      operations: [{ id: 'open', label: 'Compare plans', kind: 'link', href: '/planning/household-resilience?tab=healthcare', primary: true }],
      evidence: [{ kind: 'assumption', id: comparisons[0].plan.id, label: `${comparisons[0].plan.name} plan terms and entered claims`, source: 'manual', href: '/planning/household-resilience?tab=healthcare', verified: false }],
    }));
  }
  const unmatched = (fuel as FuelProfile).fillups.filter(fillup => fillup.matchStatus === 'unmatched');
  if (unmatched.length > 0) {
    actions.push(action({
      stableKey: `fuel-unmatched:${unmatched.map(item => item.sourceId).sort().join(',')}`,
      lane: 'fix',
      origin: 'vehicle',
      sourceId: 'fuel-tracker',
      severity: 'info',
      title: `Match ${unmatched.length} fuel purchase${unmatched.length === 1 ? '' : 's'}`,
      summary: 'Fuel Tracker records need transaction evidence before vehicle costs are fully reconciled.',
      dueDate: today,
      impact: {
        low: unmatched.reduce((sum, item) => sum + item.totalCost, 0),
        high: unmatched.reduce((sum, item) => sum + item.totalCost, 0),
        period: 'one_time',
      },
      confidence: 1,
      operations: [{ id: 'open', label: 'Review fuel matches', kind: 'link', href: '/tools/mileage?tab=fuel', primary: true }],
      evidence: unmatched.slice(0, 25).map(item => ({ kind: 'vehicle' as const, id: item.sourceId, label: `Fuel fill-up ${item.date.slice(0, 10)}`, source: 'system' as const, href: '/tools/mileage?tab=fuel', verified: false })),
    }));
  }
  return actions;
}

export async function loadResilienceEvents(
  bookGuid: string,
  currency: string,
  now = new Date(),
): Promise<FinancialEvent[]> {
  const [rentals, insurance, capital] = await Promise.all([
    getResilienceProfile(bookGuid, 'rentals'),
    getResilienceProfile(bookGuid, 'insurance'),
    getResilienceProfile(bookGuid, 'capital'),
  ]);
  const events: FinancialEvent[] = [];
  const today = now.toISOString().slice(0, 10);
  const rentRoll = calculateRentRoll((rentals as RentalsProfile).properties, now);
  for (const row of rentRoll.rows) {
    events.push({
      id: `rental:rent:${row.unitId}:${row.dueDate}`,
      bookGuid,
      domain: 'rental',
      title: `Rent due — ${row.propertyName} / ${row.unitName}`,
      description: row.tenantName || null,
      date: row.dueDate,
      endDate: null,
      cashImpact: row.balance,
      currency,
      confidence: 1,
      status: row.overdue ? 'overdue' : row.balance > 0 ? 'needs_action' : 'complete',
      href: '/business/rentals',
      sourceId: row.unitId,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: { tenantName: row.tenantName, leaseEnd: row.leaseEnd },
    });
    if (row.leaseEnd >= today) {
      events.push({
        id: `rental:lease:${row.unitId}:${row.leaseEnd}`,
        bookGuid,
        domain: 'rental',
        title: `Lease ends — ${row.tenantName || row.unitName}`,
        description: `${row.propertyName} / ${row.unitName}`,
        date: row.leaseEnd,
        endDate: null,
        cashImpact: null,
        currency,
        confidence: 1,
        status: 'needs_action',
        href: '/business/rentals',
        sourceId: row.unitId,
        actionId: null,
        planId: null,
        evidence: [],
        metadata: {},
      });
    }
  }
  for (const policy of (insurance as InsuranceProfile).policies) {
    if (policy.renewalDate < today) continue;
    events.push({
      id: `insurance:renewal:${policy.id}:${policy.renewalDate}`,
      bookGuid,
      domain: 'insurance',
      title: `${policy.type} policy renewal`,
      description: `${policy.provider} — ${policy.coveredEntity}`,
      date: policy.renewalDate,
      endDate: null,
      cashImpact: -policy.annualPremium,
      currency,
      confidence: 1,
      status: 'needs_action',
      href: '/home/protection',
      sourceId: policy.id,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: { coverageLimit: policy.coverageLimit, deductible: policy.deductible },
    });
  }
  for (const asset of calculateCapitalPlan((capital as CapitalProfile).assets, now).rows) {
    events.push({
      id: `capital:replacement:${asset.id}:${asset.replacementYear}`,
      bookGuid,
      domain: 'capital',
      title: `Replace ${asset.name}`,
      description: `${asset.category}; ${asset.fundingGap.toFixed(2)} funding gap`,
      date: `${asset.replacementYear}-07-01`,
      endDate: null,
      cashImpact: -asset.futureCost,
      currency,
      confidence: 0.8,
      status: asset.overdue ? 'overdue' : 'expected',
      href: '/home/protection?tab=capital',
      sourceId: asset.id,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: { monthlyFunding: asset.monthlyFunding },
    });
  }
  return events;
}

export function newId(): string {
  return randomUUID();
}
