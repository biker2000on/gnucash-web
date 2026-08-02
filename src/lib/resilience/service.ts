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
  mileageRate,
  parseReceiptPriceLines,
  summarizeMileage,
} from './core';
import { calculateGivingPlan, type GivingContext } from './giving-core';
import {
  CORE_DOCUMENT_KINDS as CORE_ESTATE_DOCUMENT_KINDS,
  calculateEstateReadiness,
  type EstateHouseholdMember,
} from './estate-core';
import {
  MARGIN_ALERT_PERCENT,
  MARGIN_ALERT_REVENUE_THRESHOLD,
  UNLINKED_REVENUE_ACTION_THRESHOLD,
  UNLINKED_REVENUE_WARNING_THRESHOLD,
  calculateFarmProduction,
} from './farm-production-core';
import {
  CLAIMING_DELTA_ACTION_THRESHOLD,
  EARLIEST_CLAIM_AGE,
  LATEST_CLAIM_AGE,
  SEQUENCING_DELTA_ACTION_THRESHOLD,
  analyzeRetirementIncome,
} from './retirement-income-core';
import {
  calculateEducationPlan,
  calculateFamilyBanking,
  calculateSolarPayback,
  calculateTripPlan,
  calculateUtilityAnalysis,
  calculateVehicleTco,
  parseUtilityBillText,
} from './p3-core';
import type {
  CapitalProfile,
  EducationProfile,
  EstateDocument,
  EstateProfile,
  FamilyBankingProfile,
  FarmProductionProfile,
  FuelFillup,
  FuelProfile,
  GivingProfile,
  HealthcareProfile,
  InsuranceProfile,
  LifeProfile,
  MileageProfile,
  RentalsProfile,
  ResilienceSection,
  RetirementIncomeProfile,
  TripsProfile,
  UtilitiesProfile,
  VehicleTcoProfile,
} from './types';
import type { FinancialActionCandidate } from '@/lib/financial-actions/types';
import type { EvidenceRef } from '@/lib/financial-actions/types';
import type { FinancialEvent } from '@/lib/money-timeline/types';

const id = z.string().min(1).max(100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite().min(0).max(1_000_000_000);
const signedMoney = z.number().finite().min(-1_000_000_000).max(1_000_000_000);
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
    // Vault document links (gnucash_web_entity_documents ids). Defaulted so
    // profiles saved before document linking existed still parse.
    documentIds: z.array(z.number().int().positive()).max(200).default([]),
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

const educationSchema = z.object({
  children: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(120),
    birthYear: z.number().int().min(1900).max(2300),
    collegeStartYear: z.number().int().min(1900).max(2300),
    schoolType: z.enum(['public_in_state', 'public_out_of_state', 'private']),
    yearsOfSchool: z.number().int().min(1).max(10),
    annualCostToday: money,
    tuitionInflationRate: z.number().finite().min(0).max(30),
    current529Balance: money,
    expectedAnnualReturn: z.number().finite().min(0).max(30),
    plannedMonthlyContribution: money,
    stateDeductionLimit: money,
    contributions: z.array(z.object({
      id,
      date,
      amount: money,
    })).max(10_000),
  })).max(100),
});

const utilitiesSchema = z.object({
  bills: z.array(z.object({
    id,
    date,
    type: z.enum(['electric', 'gas', 'water']),
    provider: z.string().trim().max(160),
    usage: z.number().finite().min(0).max(1_000_000_000),
    unit: z.enum(['kWh', 'therms', 'gallons']),
    totalCost: money,
    transactionGuid: z.string().max(32).nullable().optional(),
    receiptId: z.number().int().positive().nullable().optional(),
  })).max(100_000),
  solar: z.object({
    enabled: z.boolean(),
    systemCost: money,
    incentives: money,
    annualProductionKwh: z.number().finite().min(0).max(100_000_000),
    degradationRate: z.number().finite().min(0).max(20),
    electricRateInflation: z.number().finite().min(0).max(30),
    annualMaintenance: money,
    analysisYears: z.number().int().min(1).max(50),
  }),
});

const familyBankingSchema = z.object({
  children: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(120),
    liabilityAccountGuid: z.string().max(32),
    allowanceAmount: money,
    allowanceCadence: z.enum(['weekly', 'monthly']),
    nextAllowanceDate: date,
    parentMatchPercent: percent,
    savingsGoal: money,
    entries: z.array(z.object({
      id,
      date,
      description: z.string().trim().min(1).max(300),
      amount: signedMoney,
      kind: z.enum(['allowance', 'chore', 'deposit', 'spend', 'match']),
      approved: z.boolean(),
      transactionGuid: z.string().max(32).nullable().optional(),
    })).max(100_000),
  })).max(100),
});

const tripsSchema = z.object({
  trips: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(160),
    destination: z.string().trim().max(200),
    startDate: date,
    endDate: date,
    budget: money,
    savingsTarget: money,
    fundedAmount: money,
    tagId: z.number().int().positive().nullable().optional(),
    tagName: z.string().regex(/^[a-z0-9_-]{1,100}$/).nullable().optional(),
    current: z.boolean(),
    expenses: z.array(z.object({
      id,
      date,
      description: z.string().trim().min(1).max(300),
      amount: money,
      transactionGuid: z.string().max(32).nullable().optional(),
    })).max(100_000),
  })).max(500),
});

const vehicleTcoSchema = z.object({
  vehicles: z.array(z.object({
    id,
    mileageVehicleId: z.string().max(100).nullable().optional(),
    name: z.string().trim().min(1).max(160),
    purchaseDate: date,
    purchasePrice: money,
    currentValue: money,
    annualInsurance: money,
    annualRegistration: money,
    annualMaintenance: money,
    annualOther: money,
    repairCost: money,
    repairExtendsYears: z.number().int().min(1).max(20),
    replacementVehicleCost: money,
    replacementAnnualOperatingCost: money,
  })).max(200),
});

// --- Charitable giving section (schema) ---
const givingSchema = z.object({
  donations: z.array(z.object({
    id,
    date,
    charity: z.string().trim().min(1).max(200),
    kind: z.enum(['cash', 'noncash', 'qcd']),
    amount: money,
    description: z.string().max(500).nullable().optional(),
    acknowledged: z.boolean(),
    documentRef: z.string().max(500).nullable().optional(),
  })).max(10_000),
  settings: z.object({
    filingStatus: z.enum(['single', 'married_joint']),
    marginalRatePct: percent,
    stateRatePct: percent.nullable().optional(),
    agiEstimate: money.nullable().optional(),
    birthYear: z.number().int().min(1900).max(2300).nullable().optional(),
    spouseBirthYear: z.number().int().min(1900).max(2300).nullable().optional(),
    plannedAnnualGiving: money,
    standardDeductionOverride: money.nullable().optional(),
    otherItemizedAnnual: money,
  }),
});
// --- End charitable giving section (schema) ---

// --- Estate readiness section (schema) ---
/**
 * Member attribution. The roster has no stable per-member id in the entity API,
 * so records store the role plus a display-name snapshot. Both fields default so
 * profiles saved before attribution existed still parse ('household' = joint,
 * which credits every adult and preserves the old whole-household behaviour).
 */
const estateMemberRole = z.enum(['self', 'spouse', 'dependent', 'household']).default('household');
const estateMemberName = z.string().trim().max(200).default('');

const estateSchema = z.object({
  designations: z.array(z.object({
    id,
    accountLabel: z.string().trim().min(1).max(200),
    accountType: z.enum(['retirement', 'life_insurance', 'tod_investment', 'pod_bank', 'annuity', 'hsa', 'other']),
    primaryBeneficiary: z.string().trim().min(1).max(200),
    contingentBeneficiary: z.string().max(200).nullable().optional(),
    lastReviewedDate: date,
    memberRole: estateMemberRole,
    memberName: estateMemberName,
  })).max(500),
  documents: z.array(z.object({
    id,
    kind: z.enum(['will', 'revocable_trust', 'financial_poa', 'healthcare_poa', 'healthcare_directive', 'guardianship_letter', 'beneficiary_letter', 'other']),
    label: z.string().max(200).nullable().optional(),
    location: z.string().trim().max(300),
    lastUpdatedDate: date,
    reviewCycleYears: z.number().int().min(1).max(10),
    memberRole: estateMemberRole,
    memberName: estateMemberName,
    /** One vault document per estate record (gnucash_web_entity_documents.id). */
    documentId: z.number().int().positive().nullable().optional(),
  })).max(500),
  lifeEvents: z.array(z.object({
    id,
    date,
    kind: z.enum(['marriage', 'divorce', 'birth', 'death', 'move', 'major_asset_change']),
    description: z.string().max(500).nullable().optional(),
  })).max(1_000),
  settings: z.object({
    estimatedGrossEstate: money,
    maritalStatus: z.enum(['single', 'married']),
    state: z.string().regex(/^[A-Z]{2}$/),
    reviewCycleYearsDefault: z.number().int().min(1).max(10),
    survivorRunbookLocation: z.string().max(300).nullable().optional(),
    survivorRunbookUpdatedDate: date.nullable().optional(),
  }),
});
// --- End estate readiness section (schema) ---

// --- Farm production section (schema) ---
/** Record provenance seam for the future Beez Trackz sync connector. */
const farmSource = z.enum(['manual', 'beez_trackz']);
const farmSourceId = z.string().max(100).nullable().optional();
const farmQuantity = z.number().finite().min(0).max(1_000_000_000);

const farmProductionSchema = z.object({
  products: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(160),
    unit: z.string().trim().min(1).max(40),
    category: z.enum(['honey', 'eggs', 'produce', 'meat', 'value_added', 'other']),
    targetPrice: money.nullable().optional(),
  })).max(500),
  harvests: z.array(z.object({
    id,
    date,
    productId: id,
    quantity: farmQuantity,
    notes: z.string().max(500).nullable().optional(),
    source: farmSource,
    sourceId: farmSourceId,
  })).max(100_000),
  sales: z.array(z.object({
    id,
    date,
    productId: id,
    channel: z.enum(['farmers_market', 'wholesale', 'direct', 'csa', 'other']),
    quantity: farmQuantity,
    revenue: money,
    transactionGuid: z.string().max(32).nullable().optional(),
    source: farmSource,
    sourceId: farmSourceId,
  })).max(100_000),
  adjustments: z.array(z.object({
    id,
    date,
    productId: id,
    quantityDelta: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
    reason: z.string().max(300).nullable().optional(),
  })).max(100_000),
  costs: z.array(z.object({
    id,
    year: z.number().int().min(1900).max(2300),
    productId: z.string().max(100).nullable().optional(),
    label: z.string().trim().min(1).max(200),
    amount: money,
  })).max(10_000),
  settings: z.object({
    scheduleFNotes: z.string().max(2_000).nullable().optional(),
    defaultMarketDay: z.number().int().min(0).max(6).nullable().optional(),
  }),
});
// --- End farm production section (schema) ---

// --- Retirement income section (schema) ---
const retirementIncomeSchema = z.object({
  people: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(120),
    birthYear: z.number().int().min(1900).max(2300),
    pia: money,
    annualEarnings: money.nullable().optional(),
    plannedClaimAge: z.number().int().min(62).max(70),
  })).max(2),
  balances: z.object({
    taxable: money,
    traditional: money,
    roth: money,
    hsa: money,
  }),
  settings: z.object({
    filingStatus: z.enum(['single', 'married_joint']),
    annualSpending: money,
    horizonAge: z.number().int().min(70).max(110),
    colaPct: z.number().finite().min(0).max(10),
    realReturnPct: z.number().finite().min(-5).max(15),
    sequencingPreference: z.enum(['taxable_first', 'traditional_first', 'proportional']),
  }),
});
// --- End retirement income section (schema) ---

const schemas = {
  rentals: rentalsSchema,
  insurance: insuranceSchema,
  capital: capitalSchema,
  life: lifeSchema,
  healthcare: healthcareSchema,
  mileage: mileageSchema,
  fuel: fuelSchema,
  education: educationSchema,
  utilities: utilitiesSchema,
  family_banking: familyBankingSchema,
  trips: tripsSchema,
  vehicle_tco: vehicleTcoSchema,
  giving: givingSchema,
  estate: estateSchema,
  farm_production: farmProductionSchema,
  retirement_income: retirementIncomeSchema,
} satisfies Record<ResilienceSection, z.ZodType>;

const defaults = {
  rentals: { properties: [] },
  insurance: { policies: [] },
  capital: { assets: [] },
  life: { people: [] },
  healthcare: { currentPlanId: null, plans: [], claims: [] },
  mileage: { vehicles: [], trips: [] },
  fuel: { baseUrl: '', enabled: false, hasToken: false, lastSyncAt: null, vehicles: [], fillups: [] },
  education: { children: [] },
  utilities: {
    bills: [],
    solar: {
      enabled: false,
      systemCost: 0,
      incentives: 0,
      annualProductionKwh: 0,
      degradationRate: 0.5,
      electricRateInflation: 3,
      annualMaintenance: 0,
      analysisYears: 25,
    },
  },
  family_banking: { children: [] },
  trips: { trips: [] },
  vehicle_tco: { vehicles: [] },
  giving: {
    donations: [],
    settings: {
      filingStatus: 'married_joint',
      marginalRatePct: 22,
      stateRatePct: 0,
      agiEstimate: null,
      birthYear: null,
      spouseBirthYear: null,
      plannedAnnualGiving: 0,
      standardDeductionOverride: null,
      otherItemizedAnnual: 0,
    },
  },
  estate: {
    designations: [],
    documents: [],
    lifeEvents: [],
    settings: {
      estimatedGrossEstate: 0,
      maritalStatus: 'married',
      state: 'NC',
      reviewCycleYearsDefault: 3,
      survivorRunbookLocation: null,
      survivorRunbookUpdatedDate: null,
    },
  },
  farm_production: {
    products: [],
    harvests: [],
    sales: [],
    adjustments: [],
    costs: [],
    settings: { scheduleFNotes: null, defaultMarketDay: null },
  },
  retirement_income: {
    people: [],
    balances: { taxable: 0, traditional: 0, roth: 0, hsa: 0 },
    settings: {
      filingStatus: 'married_joint',
      annualSpending: 0,
      horizonAge: 90,
      colaPct: 2.5,
      realReturnPct: 4,
      sequencingPreference: 'taxable_first',
    },
  },
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
  if (section === 'education') {
    return {
      profile,
      plans: (profile as EducationProfile).children.map(child => calculateEducationPlan(child)),
    };
  }
  if (section === 'utilities') {
    const utilities = profile as UtilitiesProfile;
    return {
      profile,
      analysis: calculateUtilityAnalysis(utilities.bills),
      solar: calculateSolarPayback(utilities),
      suggestions: await loadUtilityBillSuggestions(bookGuid, utilities),
    };
  }
  if (section === 'family_banking') {
    return {
      profile,
      children: (profile as FamilyBankingProfile).children.map(child => calculateFamilyBanking(child)),
    };
  }
  if (section === 'trips') {
    const tripProfile = profile as TripsProfile;
    return {
      profile,
      trips: tripProfile.trips.map(trip => calculateTripPlan(trip)),
      suggestions: await loadTripSuggestions(bookGuid, tripProfile),
    };
  }
  if (section === 'vehicle_tco') {
    const [fuel, mileage, insurance] = await Promise.all([
      getResilienceProfile(bookGuid, 'fuel') as Promise<FuelProfile>,
      getResilienceProfile(bookGuid, 'mileage') as Promise<MileageProfile>,
      getResilienceProfile(bookGuid, 'insurance') as Promise<InsuranceProfile>,
    ]);
    const trailingStart = new Date();
    trailingStart.setUTCFullYear(trailingStart.getUTCFullYear() - 1);
    const startDate = trailingStart.toISOString();
    const currentYear = new Date().getUTCFullYear();
    return {
      profile,
      vehicles: (profile as VehicleTcoProfile).vehicles.map(vehicle => {
        const mappedVehicle = mileage.vehicles.find(item => item.id === vehicle.mileageVehicleId);
        const sharedInsurancePremium = insurance.policies
          .filter(policy => policy.type === 'auto')
          .filter(policy => !mappedVehicle || !policy.coveredEntity
            || policy.coveredEntity.toLowerCase().includes(mappedVehicle.name.toLowerCase()))
          .reduce((sum, policy) => sum + policy.annualPremium, 0);
        return calculateVehicleTco({
          vehicle,
          trailing12FuelCost: fuel.fillups
            .filter(fillup => fillup.vehicleId === vehicle.mileageVehicleId && fillup.date >= startDate)
            .reduce((sum, fillup) => sum + fillup.totalCost, 0),
          trailing12Miles: mileage.trips
            .filter(trip => trip.vehicleId === vehicle.mileageVehicleId && trip.date.startsWith(String(currentYear)))
            .reduce((sum, trip) => sum + trip.miles, 0),
          sharedInsurancePremium,
        });
      }),
      mileageVehicles: mileage.vehicles,
    };
  }
  if (section === 'giving') {
    const mileage = await getResilienceProfile(bookGuid, 'mileage') as MileageProfile;
    return {
      profile,
      plan: calculateGivingPlan(profile as GivingProfile, charityMileageContext(mileage)),
    };
  }
  // --- Estate readiness section ---
  if (section === 'estate') {
    const roster = await loadEstateRoster(bookGuid);
    return { profile, readiness: calculateEstateReadiness(profile as EstateProfile, new Date(), roster) };
  }
  // --- End estate readiness section ---
  // --- Farm production section ---
  if (section === 'farm_production') {
    return { profile, production: calculateFarmProduction(profile as FarmProductionProfile) };
  }
  // --- End farm production section ---
  // --- Retirement income section ---
  if (section === 'retirement_income') {
    return { profile, analysis: analyzeRetirementIncome(profile as RetirementIncomeProfile) };
  }
  // --- End retirement income section ---
  return { profile };
}

// --- Charitable giving section (context helper) ---
function charityMileageContext(mileage: MileageProfile, now = new Date()): GivingContext {
  const charityRows = summarizeMileage(mileage.trips, now.getUTCFullYear()).rows
    .filter(row => row.purpose === 'charity');
  return {
    charityMiles: charityRows.reduce((sum, row) => sum + row.miles, 0),
    charityMileageDeduction: charityRows.reduce((sum, row) => sum + row.deduction, 0),
  };
}
// --- End charitable giving section (context helper) ---

// --- Estate readiness section (context helper) ---
/**
 * Household roster for estate attribution, read straight from the entity
 * members table. Business roles (owner, officer) are excluded — they are not
 * household members. Books without an entity profile return an empty roster and
 * the engine falls back to household-level coverage.
 */
async function loadEstateRoster(bookGuid: string): Promise<EstateHouseholdMember[]> {
  try {
    const result = await query(
      `SELECT role, COALESCE(name, '') AS name
         FROM gnucash_web_entity_members
        WHERE book_guid = $1
          AND role IN ('self', 'spouse', 'dependent')
        ORDER BY sort_order ASC, id ASC`,
      [bookGuid],
    );
    return (result.rows as Array<{ role: string; name: string }>).map(row => ({
      role: row.role as EstateHouseholdMember['role'],
      name: row.name,
    }));
  } catch {
    // A missing entity table (fresh install) must not break estate readiness.
    return [];
  }
}
// --- End estate readiness section (context helper) ---

// --- Estate readiness section (labels) ---
const ESTATE_DOCUMENT_LABELS: Record<EstateDocument['kind'], string> = {
  will: 'Will',
  revocable_trust: 'Revocable living trust',
  financial_poa: 'Financial power of attorney',
  healthcare_poa: 'Healthcare power of attorney',
  healthcare_directive: 'Healthcare directive',
  guardianship_letter: 'Guardianship letter',
  beneficiary_letter: 'Beneficiary letter',
  other: 'Estate document',
};

/**
 * Who an estate record belongs to, for Action Center titles and summaries:
 * the recorded name when there is one, otherwise a role phrase.
 */
function estateMemberDisplay(memberRole: string | undefined, memberName: string | undefined): string {
  const name = memberName?.trim();
  if (name) return name;
  if (memberRole === 'self') return 'you';
  if (memberRole === 'spouse') return 'your spouse';
  if (memberRole === 'dependent') return 'a dependent';
  return 'the household';
}
// --- End estate readiness section (labels) ---

async function loadUtilityBillSuggestions(bookGuid: string, profile: UtilitiesProfile) {
  const existingReceiptIds = new Set(profile.bills.flatMap(bill => bill.receiptId ? [bill.receiptId] : []));
  const result = await query(
    `SELECT r.id, COALESCE(t.post_date::date, r.created_at::date)::text AS bill_date,
            COALESCE(t.description, 'Utility provider') AS provider, r.ocr_text
       FROM gnucash_web_receipts r
       LEFT JOIN transactions t ON t.guid = r.transaction_guid
      WHERE r.book_guid = $1
        AND r.ocr_status = 'completed'
        AND r.ocr_text IS NOT NULL
      ORDER BY COALESCE(t.post_date, r.created_at) DESC
      LIMIT 500`,
    [bookGuid],
  );
  return (result.rows as Array<{ id: number; bill_date: string; provider: string; ocr_text: string }>)
    .filter(row => !existingReceiptIds.has(row.id))
    .flatMap(row => {
      const parsed = parseUtilityBillText({
        receiptId: row.id,
        date: row.bill_date,
        provider: row.provider,
        text: row.ocr_text,
      });
      return parsed ? [parsed] : [];
    });
}

async function loadTripSuggestions(bookGuid: string, profile: TripsProfile) {
  if (profile.trips.length === 0) return [];
  const start = profile.trips.map(trip => trip.startDate).sort()[0];
  const end = profile.trips.map(trip => trip.endDate).sort().at(-1)!;
  const accountGuids = await getAccountGuidsForBook(bookGuid);
  if (accountGuids.length === 0) return [];
  const linked = new Set(profile.trips.flatMap(trip =>
    trip.expenses.flatMap(expense => expense.transactionGuid ? [expense.transactionGuid] : [])));
  const result = await query(
    `SELECT t.guid, t.post_date::date::text AS date, t.description,
            MAX(ABS(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric))::float8 AS amount
       FROM transactions t
       JOIN splits s ON s.tx_guid = t.guid
      WHERE s.account_guid = ANY($1::text[])
        AND t.post_date >= $2::date
        AND t.post_date <= $3::date
      GROUP BY t.guid, t.post_date, t.description
      ORDER BY t.post_date DESC
      LIMIT 1000`,
    [accountGuids, start, end],
  );
  return (result.rows as Array<{ guid: string; date: string; description: string; amount: number }>)
    .filter(row => !linked.has(row.guid))
    .flatMap(row => {
      const description = row.description.toLowerCase();
      const trip = profile.trips.find(item => {
        if (row.date < item.startDate || row.date > item.endDate) return false;
        const tokens = `${item.name} ${item.destination}`.toLowerCase().split(/[^a-z0-9]+/)
          .filter(token => token.length >= 4);
        return item.current || tokens.some(token => description.includes(token));
      });
      return trip ? [{
        tripId: trip.id,
        transactionGuid: row.guid,
        date: row.date,
        description: row.description,
        amount: Math.abs(Number(row.amount)),
      }] : [];
    });
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
  const [
    rentals,
    insurance,
    capital,
    life,
    healthcare,
    fuel,
    mileage,
    education,
    utilities,
    familyBanking,
    trips,
    vehicleTco,
    giving,
    estate,
    farmProduction,
    retirementIncome,
    items,
  ] = await Promise.all([
    getResilienceProfile(bookGuid, 'rentals'),
    getResilienceProfile(bookGuid, 'insurance'),
    getResilienceProfile(bookGuid, 'capital'),
    getResilienceProfile(bookGuid, 'life'),
    getResilienceProfile(bookGuid, 'healthcare'),
    getResilienceProfile(bookGuid, 'fuel'),
    getResilienceProfile(bookGuid, 'mileage'),
    getResilienceProfile(bookGuid, 'education'),
    getResilienceProfile(bookGuid, 'utilities'),
    getResilienceProfile(bookGuid, 'family_banking'),
    getResilienceProfile(bookGuid, 'trips'),
    getResilienceProfile(bookGuid, 'vehicle_tco'),
    getResilienceProfile(bookGuid, 'giving'),
    getResilienceProfile(bookGuid, 'estate'),
    getResilienceProfile(bookGuid, 'farm_production'),
    getResilienceProfile(bookGuid, 'retirement_income'),
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
  for (const plan of (education as EducationProfile).children.map(child => calculateEducationPlan(child))) {
    if (plan.monthlyShortfall <= 0) continue;
    actions.push(action({
      stableKey: `education-funding:${plan.id}:${plan.collegeStartYear}`,
      lane: 'decide',
      origin: 'education',
      sourceId: plan.id,
      severity: plan.yearsRemaining <= 5 ? 'warning' : 'info',
      title: `Close ${plan.name}'s education funding gap`,
      summary: `${plan.monthlyShortfall.toFixed(2)} more per month is projected to fully fund the selected education path.`,
      dueDate: `${Math.max(new Date().getUTCFullYear(), plan.collegeStartYear)}-08-01`,
      impact: { low: plan.monthlyShortfall * 12, high: plan.fundingGap, period: 'lifetime' },
      confidence: 0.75,
      operations: [{ id: 'open', label: 'Review education plan', kind: 'link', href: '/planning/education', primary: true }],
      formula: 'future tuition cost - projected 529 balance',
      assumptions: ['Returns and tuition inflation follow the entered annual assumptions.'],
      evidence: [{ kind: 'education_goal', id: plan.id, label: `${plan.name} education goal`, source: 'manual', href: '/planning/education', verified: false }],
    }));
  }
  const utilityAnalysis = calculateUtilityAnalysis((utilities as UtilitiesProfile).bills);
  for (const row of utilityAnalysis.byType) {
    if (!row.latest || (row.rateChangePercent <= 15 && row.usageChangePercent <= 20)) continue;
    const rateDriven = row.rateChangePercent > row.usageChangePercent;
    actions.push(action({
      stableKey: `utility-change:${row.type}:${row.latest.date}`,
      lane: 'decide',
      origin: 'utility',
      sourceId: row.latest.id,
      severity: Math.max(row.rateChangePercent, row.usageChangePercent) >= 30 ? 'warning' : 'info',
      title: `Review ${row.type} ${rateDriven ? 'rate' : 'usage'} increase`,
      summary: `${rateDriven ? 'Unit rate' : 'Usage'} rose ${Math.max(row.rateChangePercent, row.usageChangePercent).toFixed(1)}% from the prior bill.`,
      dueDate: null,
      impact: { low: 0, high: row.latest.totalCost * 12, period: 'annual' },
      confidence: 0.9,
      operations: [{ id: 'open', label: 'Review utility history', kind: 'link', href: '/planning/utilities', primary: true }],
      evidence: [{ kind: 'utility_bill', id: row.latest.id, label: `${row.latest.provider} ${row.latest.date}`, source: row.latest.receiptId ? 'receipt' : 'manual', href: '/planning/utilities', verified: Boolean(row.latest.receiptId) }],
    }));
  }
  const solar = calculateSolarPayback(utilities as UtilitiesProfile);
  if ((utilities as UtilitiesProfile).solar.enabled && solar.paybackYear != null && solar.lifetimeSavings > 0) {
    actions.push(action({
      stableKey: `solar-scenario:${solar.upfrontCost}:${solar.paybackYear}`,
      lane: 'decide',
      origin: 'utility',
      sourceId: 'solar',
      severity: 'info',
      title: 'Evaluate the solar capital scenario',
      summary: `Entered usage and rates imply a ${solar.paybackYear}-year payback and ${solar.lifetimeSavings.toFixed(2)} lifetime net savings.`,
      dueDate: null,
      impact: { low: solar.lifetimeSavings, high: solar.lifetimeSavings, period: 'lifetime' },
      confidence: 0.7,
      operations: [{ id: 'open', label: 'Review solar scenario', kind: 'link', href: '/planning/utilities?tab=solar', primary: true }],
      assumptions: ['Production, degradation, utility inflation, incentives, and maintenance follow entered assumptions.'],
      evidence: [{ kind: 'assumption', id: 'solar', label: 'Solar scenario inputs', source: 'manual', href: '/planning/utilities?tab=solar', verified: false }],
    }));
  }
  for (const child of (familyBanking as FamilyBankingProfile).children.map(item => calculateFamilyBanking(item))) {
    if (child.pendingCount > 0) {
      actions.push(action({
        stableKey: `family-approval:${child.child.id}:${child.pendingCount}`,
        lane: 'do',
        origin: 'family',
        sourceId: child.child.id,
        severity: 'info',
        title: `Approve ${child.pendingCount} item${child.pendingCount === 1 ? '' : 's'} for ${child.child.name}`,
        summary: `${child.pendingAmount.toFixed(2)} in chores or adjustments is waiting for parent approval.`,
        dueDate: today,
        impact: { low: Math.abs(child.pendingAmount), high: Math.abs(child.pendingAmount), period: 'one_time' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Review family ledger', kind: 'link', href: '/planning/family-banking', primary: true }],
        evidence: [{ kind: 'family_ledger', id: child.child.id, label: `${child.child.name} ledger`, source: 'manual', href: '/planning/family-banking', verified: false }],
      }));
    }
    if (child.allowanceDue) {
      actions.push(action({
        stableKey: `allowance-due:${child.child.id}:${child.child.nextAllowanceDate}`,
        lane: 'do',
        origin: 'family',
        sourceId: child.child.id,
        severity: 'info',
        title: `Record ${child.child.name}'s allowance`,
        summary: `${child.child.allowanceAmount.toFixed(2)} is due into the linked liability-backed balance.`,
        dueDate: child.child.nextAllowanceDate,
        impact: { low: child.child.allowanceAmount, high: child.child.allowanceAmount, period: 'one_time' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Open family banking', kind: 'link', href: '/planning/family-banking', primary: true }],
        evidence: [{ kind: 'rule', id: child.child.id, label: `${child.child.allowanceCadence} allowance rule`, source: 'rule', href: '/planning/family-banking', verified: true }],
      }));
    }
  }
  for (const trip of (trips as TripsProfile).trips.map(item => calculateTripPlan(item))) {
    if (trip.status !== 'complete' && trip.fundingGap > 0) {
      actions.push(action({
        stableKey: `trip-funding:${trip.trip.id}:${trip.trip.startDate}`,
        lane: 'decide',
        origin: 'trip',
        sourceId: trip.trip.id,
        severity: trip.trip.startDate <= today ? 'critical' : 'info',
        title: `Fund ${trip.trip.name}`,
        summary: `${trip.fundingGap.toFixed(2)} remains, requiring about ${trip.requiredMonthlySavings.toFixed(2)} per month.`,
        dueDate: trip.trip.startDate,
        impact: { low: trip.fundingGap, high: trip.fundingGap, period: 'one_time' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Review trip budget', kind: 'link', href: '/planning/trips', primary: true }],
        evidence: [{ kind: 'trip', id: trip.trip.id, label: trip.trip.name, source: 'manual', href: '/planning/trips', verified: false }],
      }));
    }
    if (trip.remainingBudget < 0) {
      actions.push(action({
        stableKey: `trip-over-budget:${trip.trip.id}:${Math.abs(trip.remainingBudget).toFixed(2)}`,
        lane: 'decide',
        origin: 'trip',
        sourceId: trip.trip.id,
        severity: 'warning',
        title: `${trip.trip.name} is over budget`,
        summary: `Linked and entered expenses exceed the plan by ${Math.abs(trip.remainingBudget).toFixed(2)}.`,
        dueDate: trip.trip.endDate,
        impact: { low: Math.abs(trip.remainingBudget), high: Math.abs(trip.remainingBudget), period: 'one_time' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Review trip spending', kind: 'link', href: '/planning/trips', primary: true }],
        evidence: [{ kind: 'trip', id: trip.trip.id, label: trip.trip.name, source: 'manual', href: '/planning/trips', verified: false }],
      }));
    }
  }
  const mileageProfile = mileage as MileageProfile;
  const fuelProfile = fuel as FuelProfile;
  const insuranceProfile = insurance as InsuranceProfile;
  const trailingStart = new Date();
  trailingStart.setUTCFullYear(trailingStart.getUTCFullYear() - 1);
  for (const vehicle of (vehicleTco as VehicleTcoProfile).vehicles) {
    const linked = mileageProfile.vehicles.find(item => item.id === vehicle.mileageVehicleId);
    const result = calculateVehicleTco({
      vehicle,
      trailing12FuelCost: fuelProfile.fillups
        .filter(fillup => fillup.vehicleId === vehicle.mileageVehicleId && fillup.date >= trailingStart.toISOString())
        .reduce((sum, fillup) => sum + fillup.totalCost, 0),
      trailing12Miles: mileageProfile.trips
        .filter(trip => trip.vehicleId === vehicle.mileageVehicleId && trip.date.startsWith(String(new Date().getUTCFullYear())))
        .reduce((sum, trip) => sum + trip.miles, 0),
      sharedInsurancePremium: insuranceProfile.policies
        .filter(policy => policy.type === 'auto' && (!linked || policy.coveredEntity.toLowerCase().includes(linked.name.toLowerCase())))
        .reduce((sum, policy) => sum + policy.annualPremium, 0),
    });
    if (result.decisionSavings <= 0) continue;
    actions.push(action({
      stableKey: `vehicle-decision:${vehicle.id}:${result.recommendedDecision}:${vehicle.repairCost}:${vehicle.replacementVehicleCost}`,
      lane: 'decide',
      origin: 'vehicle',
      sourceId: vehicle.id,
      severity: result.decisionSavings >= 5_000 ? 'warning' : 'info',
      title: `${result.recommendedDecision === 'repair' ? 'Repair' : 'Replace'} ${vehicle.name}`,
      summary: `The entered ${vehicle.repairExtendsYears}-year scenario favors ${result.recommendedDecision} by ${result.decisionSavings.toFixed(2)}.`,
      dueDate: null,
      impact: { low: result.decisionSavings, high: result.decisionSavings, period: 'one_time' },
      confidence: 0.75,
      operations: [{ id: 'open', label: 'Review vehicle TCO', kind: 'link', href: '/tools/vehicle-tco', primary: true }],
      assumptions: ['Future operating costs follow the entered repair and replacement assumptions.'],
      evidence: [{ kind: 'vehicle', id: vehicle.id, label: vehicle.name, source: 'manual', href: '/tools/vehicle-tco', verified: false }],
    }));
  }
  // --- Charitable giving section (actions) ---
  const givingPlan = calculateGivingPlan(
    giving as GivingProfile,
    charityMileageContext(mileageProfile, now),
    now,
  );
  const currentGivingYear = givingPlan.currentYear;
  const charityRate = mileageRate(`${currentGivingYear}-12-31`, 'charity');
  for (const donation of givingPlan.donations) {
    if (donation.needsAcknowledgment) {
      actions.push(action({
        stableKey: `giving:ack:${donation.id}`,
        lane: 'fix',
        origin: 'giving',
        sourceId: donation.id,
        severity: donation.amount > 1_000 ? 'warning' : 'info',
        title: `Get an acknowledgment letter from ${donation.charity}`,
        summary: `The ${donation.amount.toFixed(2)} ${donation.kind} donation on ${donation.date} needs a written acknowledgment to substantiate the deduction.`,
        dueDate: `${donation.taxYear + 1}-04-15`,
        impact: { low: donation.amount, high: donation.amount, period: 'one_time' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Open giving log', kind: 'link', href: '/planning/giving', primary: true }],
        result: donation.amount,
        assumptions: ['Donations of $250 or more require a contemporaneous written acknowledgment.'],
        evidence: [{ kind: 'donation', id: donation.id, label: `${donation.charity} — ${donation.date}`, source: 'manual', href: '/planning/giving', verified: false }],
      }));
    }
    if (donation.needsAppraisal) {
      actions.push(action({
        stableKey: `giving:appraisal:${donation.id}`,
        lane: 'fix',
        origin: 'giving',
        sourceId: donation.id,
        severity: 'warning',
        title: `Obtain a qualified appraisal for ${donation.charity}`,
        summary: `The ${donation.amount.toFixed(2)} noncash donation on ${donation.date} exceeds $5,000 and requires a qualified appraisal.`,
        dueDate: `${donation.taxYear + 1}-04-15`,
        impact: { low: donation.amount, high: donation.amount, period: 'one_time' },
        confidence: 1,
        operations: [{ id: 'open', label: 'Open giving log', kind: 'link', href: '/planning/giving', primary: true }],
        result: donation.amount,
        assumptions: ['Noncash donations above $5,000 require a qualified appraisal and Form 8283 Section B.'],
        evidence: [{ kind: 'donation', id: donation.id, label: `${donation.charity} — ${donation.date}`, source: 'manual', href: '/planning/giving', verified: false }],
      }));
    }
  }
  for (const yearRow of givingPlan.yearTotals) {
    if (!yearRow.form8283Required || yearRow.taxYear < currentGivingYear - 1) continue;
    actions.push(action({
      stableKey: `giving:8283:${yearRow.taxYear}`,
      lane: 'fix',
      origin: 'giving',
      sourceId: String(yearRow.taxYear),
      severity: 'info',
      title: `File Form 8283 with the ${yearRow.taxYear} return`,
      summary: `Noncash donations total ${yearRow.noncashTotal.toFixed(2)} for ${yearRow.taxYear}, above the $500 Form 8283 threshold.`,
      dueDate: `${yearRow.taxYear + 1}-04-15`,
      impact: { low: yearRow.noncashTotal, high: yearRow.noncashTotal, period: 'one_time' },
      confidence: 1,
      operations: [{ id: 'open', label: 'Open giving log', kind: 'link', href: '/planning/giving', primary: true }],
      result: yearRow.noncashTotal,
      assumptions: ['Form 8283 is required when total noncash donations for the year exceed $500.'],
      evidence: [{ kind: 'donation', id: String(yearRow.taxYear), label: `${yearRow.taxYear} noncash donations`, source: 'manual', href: '/planning/giving', verified: false }],
    }));
  }
  if (givingPlan.bunching.estimatedTaxSavings >= 250) {
    const savings = givingPlan.bunching.estimatedTaxSavings;
    actions.push(action({
      stableKey: `giving:bunching:${currentGivingYear}:${Math.round(savings)}`,
      lane: 'decide',
      origin: 'giving',
      sourceId: 'bunching',
      severity: 'info',
      title: 'Consider bunching two years of charitable giving',
      summary: `Bunching ${givingPlan.bunching.plannedAnnualGiving.toFixed(2)} × 2 into one year and taking the standard deduction the next is estimated to save ${savings.toFixed(2)} in tax.`,
      dueDate: `${currentGivingYear}-12-31`,
      impact: { low: savings * 0.7, high: savings, period: 'one_time' },
      confidence: 0.8,
      operations: [{ id: 'open', label: 'Review bunching comparison', kind: 'link', href: '/planning/giving', primary: true }],
      result: savings,
      formula: givingPlan.bunching.formula,
      assumptions: [
        `Standard deduction ${givingPlan.bunching.standardDeduction.toFixed(2)} for ${givingPlan.bunching.taxYear} is assumed for both years of the window.`,
        'Marginal and state rates stay constant across the two-year window.',
        'A donor-advised fund can front-load the bunched gift while grants continue annually.',
      ],
      evidence: [{ kind: 'assumption', id: 'giving-settings', label: 'Planned giving and itemized deduction inputs', source: 'manual', href: '/planning/giving', verified: false }],
    }));
  }
  if (givingPlan.qcd.eligible && givingPlan.settings.plannedAnnualGiving > 0) {
    actions.push(action({
      stableKey: `giving:qcd:${currentGivingYear}`,
      lane: 'decide',
      origin: 'giving',
      sourceId: 'qcd',
      severity: 'info',
      title: 'Consider qualified charitable distributions from an IRA',
      summary: `QCDs up to ${givingPlan.qcd.householdAnnualLimit.toFixed(2)} per year can satisfy giving directly from a traditional IRA without itemizing.`,
      dueDate: `${currentGivingYear}-12-31`,
      impact: { low: 0, high: givingPlan.settings.plannedAnnualGiving, period: 'annual' },
      confidence: 0.8,
      operations: [{ id: 'open', label: 'Review QCD status', kind: 'link', href: '/planning/giving', primary: true }],
      result: givingPlan.qcd.remainingCapacity,
      assumptions: [
        'QCD eligibility begins at age 70½; with only birth years, eligibility is assumed once age 71 is reached by year end.',
        `Per-person QCD limit ${givingPlan.qcd.annualLimitPerPerson.toFixed(2)} (2025 indexed figure).`,
        `Charity mileage is separately deductible at ${charityRate.toFixed(2)} per mile.`,
      ],
      evidence: [{ kind: 'assumption', id: 'giving-qcd', label: 'Birth years and planned giving inputs', source: 'manual', href: '/planning/giving', verified: false }],
    }));
  }
  // --- End charitable giving section (actions) ---
  // --- Estate readiness section (actions) ---
  const estateReadiness = calculateEstateReadiness(estate as EstateProfile, now, await loadEstateRoster(bookGuid));
  for (const designation of estateReadiness.designations) {
    if (!designation.stale) continue;
    actions.push(action({
      stableKey: `estate:designation:${designation.id}:${designation.lastReviewedDate}`,
      lane: 'fix',
      origin: 'estate',
      sourceId: designation.id,
      severity: designation.staleReason === 'life_event' ? 'warning' : 'info',
      title: `Re-confirm beneficiaries on ${designation.accountLabel}`,
      summary: designation.staleReason === 'life_event' && designation.triggeringLifeEvent
        ? `The ${designation.triggeringLifeEvent.kind.replaceAll('_', ' ')} on ${designation.triggeringLifeEvent.date} postdates the last beneficiary review on ${designation.lastReviewedDate}.`
        : `The designation was last reviewed ${designation.lastReviewedDate}, past the ${estateReadiness.settings.reviewCycleYearsDefault}-year review cycle.`,
      dueDate: today,
      confidence: 1,
      operations: [{ id: 'open', label: 'Review designations', kind: 'link', href: '/planning/estate', primary: true }],
      result: designation.daysSinceReview,
      assumptions: ['Beneficiary designations override the will; they must be re-confirmed after life events.'],
      evidence: [{ kind: 'beneficiary', id: designation.id, label: `${designation.accountLabel} beneficiary designation`, source: 'manual', href: '/planning/estate', verified: false }],
    }));
  }
  for (const document of estateReadiness.documents) {
    if (!document.overdue) continue;
    const documentLabel = document.label || ESTATE_DOCUMENT_LABELS[document.kind];
    const owner = estateMemberDisplay(document.memberRole, document.memberName);
    actions.push(action({
      // The member is part of the key: two adults can each hold an overdue
      // document of the same kind, and they must dismiss independently.
      stableKey: `estate:document:${document.memberRole ?? 'household'}:${document.kind}:${document.dueDate}`,
      lane: 'fix',
      origin: 'estate',
      sourceId: document.id,
      severity: (CORE_ESTATE_DOCUMENT_KINDS as readonly string[]).includes(document.kind) ? 'warning' : 'info',
      title: `Review the ${documentLabel.toLowerCase()} for ${owner}`,
      summary: `${documentLabel} for ${owner} was last updated ${document.lastUpdatedDate}; the ${document.reviewCycleYears}-year review was due ${document.dueDate}.`,
      dueDate: document.dueDate,
      confidence: 1,
      operations: [{ id: 'open', label: 'Review documents', kind: 'link', href: '/planning/estate', primary: true }],
      result: Math.abs(document.daysUntilDue),
      evidence: [{ kind: 'estate_document', id: document.id, label: `${documentLabel} — ${document.location || 'location not recorded'}`, source: 'manual', href: '/planning/estate', verified: false }],
    }));
  }
  // One item per (adult, missing core kind). With no roster the engine reports a
  // single household-level gap list, which lands here as memberRole 'household'.
  const missingCoreItems = estateReadiness.coverage.members.length > 0
    ? estateReadiness.coverage.missingByMember
    : estateReadiness.coverage.missingCoreDocuments.map(kind => ({ role: 'household' as const, name: '', kind }));
  for (const item of missingCoreItems) {
    const who = estateMemberDisplay(item.role, item.name);
    actions.push(action({
      stableKey: `estate:document:${item.role}:${item.kind}:missing`,
      lane: 'fix',
      origin: 'estate',
      sourceId: `${item.role}:${item.kind}`,
      severity: 'warning',
      title: `Put a ${ESTATE_DOCUMENT_LABELS[item.kind].toLowerCase()} in place for ${who}`,
      summary: `No ${ESTATE_DOCUMENT_LABELS[item.kind].toLowerCase()} is on file for ${who}; it is one of the four core estate documents, and each adult needs their own.`,
      dueDate: null,
      confidence: 1,
      operations: [{ id: 'open', label: 'Review documents', kind: 'link', href: '/planning/estate', primary: true }],
      assumptions: [
        'Core coverage means a will, financial POA, healthcare POA, and healthcare directive; a revocable trust is optional.',
        'Each adult household member needs their own set; documents attributed to the household count for everyone.',
      ],
      evidence: [{ kind: 'estate_document', id: `${item.role}:${item.kind}`, label: `${ESTATE_DOCUMENT_LABELS[item.kind]} for ${who} (missing)`, source: 'manual', href: '/planning/estate', verified: false }],
    }));
  }
  if (estateReadiness.exposure.exposure > 0) {
    const estateTax = estateReadiness.exposure.estimatedTax;
    actions.push(action({
      stableKey: `estate:exposure:${Math.round(estateReadiness.exposure.exposure)}`,
      lane: 'decide',
      origin: 'estate',
      sourceId: 'estate-exposure',
      severity: 'warning',
      title: 'Plan for federal estate tax exposure',
      summary: `The estimated gross estate exceeds the applied federal exemption by ${estateReadiness.exposure.exposure.toFixed(2)}, implying roughly ${estateTax.toFixed(2)} of estate tax at the top rate.`,
      dueDate: null,
      impact: { low: Math.round(estateTax * 0.5 * 100) / 100, high: estateTax, period: 'one_time' },
      confidence: 0.6,
      operations: [{ id: 'open', label: 'Review estate exposure', kind: 'link', href: '/planning/estate', primary: true }],
      result: estateTax,
      formula: estateReadiness.exposure.formula,
      assumptions: estateReadiness.exposure.assumptions,
      evidence: [{ kind: 'assumption', id: 'estate-exposure', label: 'Estimated gross estate and marital status inputs', source: 'manual', href: '/planning/estate', verified: false }],
    }));
  }
  if (!estateReadiness.runbook.current) {
    actions.push(action({
      stableKey: `estate:runbook:${estateReadiness.settings.survivorRunbookUpdatedDate ?? 'missing'}`,
      lane: 'fix',
      origin: 'estate',
      sourceId: 'survivor-runbook',
      severity: 'info',
      title: estateReadiness.runbook.present ? 'Refresh the survivor runbook' : 'Write a survivor runbook',
      summary: estateReadiness.runbook.present
        ? 'The survivor runbook is more than two years old (or has no update date); accounts, passwords, and contacts drift.'
        : 'No survivor runbook location is recorded; survivors need a map of accounts, advisors, and first steps.',
      dueDate: today,
      confidence: 1,
      operations: [{ id: 'open', label: 'Review runbook status', kind: 'link', href: '/planning/estate', primary: true }],
      assumptions: ['A survivor runbook is considered current when updated within the last two years.'],
      evidence: [{ kind: 'estate_document', id: 'survivor-runbook', label: 'Survivor runbook', source: 'manual', href: '/planning/estate', verified: false }],
    }));
  }
  // --- End estate readiness section (actions) ---
  // --- Farm production section (actions) ---
  const production = calculateFarmProduction(farmProduction as FarmProductionProfile, now);
  for (const stock of production.flags.negativeStock) {
    actions.push(action({
      stableKey: `farm:negative-stock:${stock.productId}:${Math.round(stock.onHandQty)}`,
      lane: 'fix',
      origin: 'farm',
      sourceId: stock.productId,
      severity: 'warning',
      title: `Reconcile negative ${stock.name} stock`,
      summary: `On-hand is ${stock.onHandQty.toFixed(2)} ${stock.unit} — more was sold than harvested plus adjustments; a harvest, sale, or adjustment record is missing or wrong.`,
      dueDate: today,
      confidence: 1,
      operations: [{ id: 'open', label: 'Open farm production', kind: 'link', href: '/business/farm-production', primary: true }],
      result: stock.onHandQty,
      formula: 'on-hand = harvested + adjustments − sold',
      assumptions: ['Negative on-hand is treated as a data-quality signal, not a valid stock level.'],
      evidence: [{ kind: 'farm_record', id: stock.productId, label: `${stock.name} stock ledger`, source: 'manual', href: '/business/farm-production', verified: false }],
    }));
  }
  if (production.flags.unlinkedSales.revenue > UNLINKED_REVENUE_ACTION_THRESHOLD) {
    const unlinkedRevenue = production.flags.unlinkedSales.revenue;
    actions.push(action({
      stableKey: `farm:unlinked-sales:${production.currentYear}:${production.flags.unlinkedSales.count}`,
      lane: 'fix',
      origin: 'farm',
      sourceId: 'unlinked-sales',
      severity: unlinkedRevenue > UNLINKED_REVENUE_WARNING_THRESHOLD ? 'warning' : 'info',
      title: `Link ${production.flags.unlinkedSales.count} farm sale${production.flags.unlinkedSales.count === 1 ? '' : 's'} to transactions`,
      summary: `${unlinkedRevenue.toFixed(2)} of ${production.currentYear} sales revenue has no GnuCash transaction linked, so Schedule F income cannot be reconciled to the ledger.`,
      dueDate: today,
      impact: { low: unlinkedRevenue, high: unlinkedRevenue, period: 'one_time' },
      confidence: 1,
      operations: [{ id: 'open', label: 'Review farm sales', kind: 'link', href: '/business/farm-production', primary: true }],
      result: unlinkedRevenue,
      evidence: [{ kind: 'farm_record', id: `unlinked-sales-${production.currentYear}`, label: `${production.currentYear} unlinked farm sales`, source: 'manual', href: '/business/farm-production', verified: false }],
    }));
  }
  for (const row of production.current.products) {
    if (row.revenue <= MARGIN_ALERT_REVENUE_THRESHOLD || row.marginPercent >= MARGIN_ALERT_PERCENT) continue;
    actions.push(action({
      stableKey: `farm:margin:${row.productId}:${production.currentYear}`,
      lane: 'decide',
      origin: 'farm',
      sourceId: row.productId,
      severity: 'info',
      title: `Review ${row.name} pricing or input costs`,
      summary: `${row.name} earned ${row.revenue.toFixed(2)} this year at a ${row.marginPercent.toFixed(1)}% gross margin, below the ${MARGIN_ALERT_PERCENT}% screen.`,
      dueDate: null,
      impact: { low: 0, high: Math.max(0, row.revenue * MARGIN_ALERT_PERCENT / 100 - row.grossMargin), period: 'annual' },
      confidence: 0.8,
      operations: [{ id: 'open', label: 'Review product margins', kind: 'link', href: '/business/farm-production', primary: true }],
      result: row.marginPercent,
      formula: 'margin % = (revenue − product costs − whole-farm costs × revenue share) ÷ revenue × 100',
      assumptions: ['Whole-farm costs allocate by revenue share (produced-quantity share when there is no revenue).'],
      evidence: [{ kind: 'farm_record', id: row.productId, label: `${row.name} ${production.currentYear} results`, source: 'manual', href: '/business/farm-production', verified: false }],
    }));
  }
  // --- End farm production section (actions) ---
  // --- Retirement income section (actions) ---
  const retirement = analyzeRetirementIncome(retirementIncome as RetirementIncomeProfile, now);
  for (const person of retirement.people) {
    if (person.piaSource === 'missing') continue;
    if (person.recommendedClaimAge === person.plannedClaimAge) continue;
    if (person.lifetimeDelta < CLAIMING_DELTA_ACTION_THRESHOLD) continue;
    actions.push(action({
      stableKey: `retirement:claiming:${person.personId}:${person.recommendedClaimAge}`,
      lane: 'decide',
      origin: 'retirement',
      sourceId: person.personId,
      severity: 'info',
      title: `Consider claiming Social Security at ${person.recommendedLabel} for ${person.name}`,
      summary: `Claiming at ${person.recommendedLabel} instead of ${person.plannedClaimAge} projects ${person.lifetimeDelta.toFixed(2)} more cumulative benefits through age ${retirement.settings.horizonAge}.`,
      dueDate: null,
      impact: { low: Math.round(person.lifetimeDelta * 0.5 * 100) / 100, high: person.lifetimeDelta, period: 'lifetime' },
      confidence: 0.65,
      operations: [{ id: 'open', label: 'Review claiming comparison', kind: 'link', href: '/planning/retirement-income', primary: true }],
      result: person.lifetimeDelta,
      formula: 'lifetime delta = Σ monthly benefit × COLA factor (recommended claim age) − Σ monthly benefit × COLA factor (planned claim age), through the horizon age',
      assumptions: retirement.assumptions,
      evidence: [{ kind: 'assumption', id: person.personId, label: `${person.name} claiming inputs (PIA ${person.piaSource})`, source: 'manual', href: '/planning/retirement-income', verified: false }],
    }));
  }
  const irmaa = retirement.irmaa;
  if (irmaa?.withinCliff && irmaa.nextTierThreshold != null) {
    actions.push(action({
      stableKey: `retirement:irmaa:${irmaa.year}:${irmaa.tier + 1}`,
      lane: 'decide',
      origin: 'retirement',
      sourceId: 'irmaa-cliff',
      severity: 'info',
      title: 'Projected income sits near an IRMAA cliff',
      summary: `First-year MAGI of ${irmaa.magi.toFixed(2)} is within ${(irmaa.headroomToNextTier ?? 0).toFixed(2)} of the ${irmaa.nextTierThreshold.toLocaleString('en-US')} IRMAA threshold, which adds ${irmaa.surchargeDeltaAnnual.toFixed(2)} per enrollee per year in Medicare surcharges.`,
      dueDate: null,
      impact: { low: irmaa.surchargeDeltaAnnual, high: irmaa.surchargeDeltaAnnual, period: 'annual' },
      confidence: 0.7,
      operations: [{ id: 'open', label: 'Review IRMAA headroom', kind: 'link', href: '/planning/retirement-income', primary: true }],
      result: irmaa.surchargeDeltaAnnual,
      formula: 'surcharge delta = next-tier annual surcharge − current-tier annual surcharge (2026 Part B + Part D tables)',
      assumptions: retirement.assumptions,
      evidence: [{ kind: 'tax_table', id: `irmaa-${irmaa.year}`, label: '2026 IRMAA tiers', source: 'system', href: '/planning/retirement-income', verified: true }],
    }));
  }
  const sequencing = retirement.sequencing;
  if (sequencing
    && sequencing.preferredVariantId != null
    && sequencing.bestVariantId !== sequencing.preferredVariantId
    && sequencing.endingValueDelta >= SEQUENCING_DELTA_ACTION_THRESHOLD) {
    const best = sequencing.variants.find(variant => variant.id === sequencing.bestVariantId)!;
    actions.push(action({
      stableKey: `retirement:sequencing:${sequencing.bestVariantId}`,
      lane: 'decide',
      origin: 'retirement',
      sourceId: 'sequencing',
      severity: 'info',
      title: `Compare a ${best.label.toLowerCase()} withdrawal order`,
      summary: `Switching from ${sequencing.preferredVariantId.replaceAll('_', ' ')} projects ${sequencing.endingValueDelta.toFixed(2)} more ending portfolio value at age ${retirement.settings.horizonAge}.`,
      dueDate: null,
      impact: { low: Math.round(sequencing.endingValueDelta * 0.5 * 100) / 100, high: sequencing.endingValueDelta, period: 'lifetime' },
      confidence: 0.65,
      operations: [{ id: 'open', label: 'Review sequencing comparison', kind: 'link', href: '/planning/retirement-income', primary: true }],
      result: sequencing.endingValueDelta,
      formula: 'ending-value delta = best variant ending total − preferred variant ending total (drawdown engine)',
      assumptions: retirement.assumptions,
      evidence: [{ kind: 'assumption', id: 'retirement-sequencing', label: 'Balances, spending, and return inputs', source: 'manual', href: '/planning/retirement-income', verified: false }],
    }));
  }
  // --- End retirement income section (actions) ---
  return actions;
}

export async function loadResilienceEvents(
  bookGuid: string,
  currency: string,
  now = new Date(),
): Promise<FinancialEvent[]> {
  const [rentals, insurance, capital, education, utilities, familyBanking, trips, giving, givingMileage, estate, farmProduction, retirementIncome] = await Promise.all([
    getResilienceProfile(bookGuid, 'rentals'),
    getResilienceProfile(bookGuid, 'insurance'),
    getResilienceProfile(bookGuid, 'capital'),
    getResilienceProfile(bookGuid, 'education'),
    getResilienceProfile(bookGuid, 'utilities'),
    getResilienceProfile(bookGuid, 'family_banking'),
    getResilienceProfile(bookGuid, 'trips'),
    getResilienceProfile(bookGuid, 'giving'),
    getResilienceProfile(bookGuid, 'mileage'),
    getResilienceProfile(bookGuid, 'estate'),
    getResilienceProfile(bookGuid, 'farm_production'),
    getResilienceProfile(bookGuid, 'retirement_income'),
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
  for (const plan of (education as EducationProfile).children.map(child => calculateEducationPlan(child, now))) {
    const collegeDate = `${plan.collegeStartYear}-08-01`;
    if (collegeDate < today) continue;
    events.push({
      id: `education:start:${plan.id}:${plan.collegeStartYear}`,
      bookGuid,
      domain: 'education',
      title: `${plan.name} education funding begins`,
      description: `${plan.schoolType.replaceAll('_', ' ')}; ${plan.fundingGap.toFixed(2)} projected gap`,
      date: collegeDate,
      endDate: `${plan.collegeStartYear + plan.yearsOfSchool}-05-31`,
      cashImpact: -plan.projectedCost,
      currency,
      confidence: 0.75,
      status: plan.fundingGap > 0 ? 'needs_action' : 'expected',
      href: '/planning/education',
      sourceId: plan.id,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: { monthlyFunding: plan.requiredMonthlyContribution, glidePath: plan.glidePath },
    });
  }
  for (const row of calculateUtilityAnalysis((utilities as UtilitiesProfile).bills).byType) {
    if (!row.latest) continue;
    const nextDate = new Date(`${row.latest.date}T12:00:00Z`);
    nextDate.setUTCMonth(nextDate.getUTCMonth() + 1);
    const dateValue = nextDate.toISOString().slice(0, 10);
    if (dateValue < today) continue;
    events.push({
      id: `utility:bill:${row.type}:${dateValue}`,
      bookGuid,
      domain: 'utility',
      title: `Expected ${row.type} bill`,
      description: row.latest.provider || null,
      date: dateValue,
      endDate: null,
      cashImpact: -row.latest.totalCost,
      currency,
      confidence: 0.7,
      status: 'expected',
      href: '/planning/utilities',
      sourceId: row.latest.id,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: { expectedUsage: row.latest.usage, unit: row.latest.unit },
    });
  }
  for (const child of (familyBanking as FamilyBankingProfile).children) {
    if (child.nextAllowanceDate < today) continue;
    events.push({
      id: `family:allowance:${child.id}:${child.nextAllowanceDate}`,
      bookGuid,
      domain: 'family',
      title: `${child.name} allowance`,
      description: `${child.allowanceCadence} liability-backed allowance`,
      date: child.nextAllowanceDate,
      endDate: null,
      cashImpact: -child.allowanceAmount,
      currency,
      confidence: 1,
      status: 'needs_action',
      href: '/planning/family-banking',
      sourceId: child.id,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: { liabilityAccountGuid: child.liabilityAccountGuid },
    });
  }
  for (const trip of (trips as TripsProfile).trips.map(item => calculateTripPlan(item, now))) {
    if (trip.trip.endDate < today) continue;
    events.push({
      id: `trip:start:${trip.trip.id}:${trip.trip.startDate}`,
      bookGuid,
      domain: 'trip',
      title: `${trip.trip.name} begins`,
      description: trip.trip.destination || null,
      date: trip.trip.startDate,
      endDate: trip.trip.endDate,
      cashImpact: -Math.max(0, trip.remainingBudget),
      currency,
      confidence: 1,
      status: trip.fundingGap > 0 ? 'needs_action' : 'expected',
      href: '/planning/trips',
      sourceId: trip.trip.id,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: { budget: trip.trip.budget, spent: trip.spent, fundingGap: trip.fundingGap },
    });
  }
  // --- Charitable giving section (events) ---
  const givingProfile = giving as GivingProfile;
  const givingPlan = calculateGivingPlan(
    givingProfile,
    charityMileageContext(givingMileage as MileageProfile, now),
    now,
  );
  if (givingProfile.settings.plannedAnnualGiving > 0 || givingProfile.donations.length > 0) {
    events.push({
      id: `giving:year-end:${givingPlan.currentYear}`,
      bookGuid,
      domain: 'giving',
      title: 'Year-end charitable giving deadline',
      description: `Donations must post by December 31 to count for ${givingPlan.currentYear}.`,
      date: `${givingPlan.currentYear}-12-31`,
      endDate: null,
      cashImpact: -givingPlan.remainingPlannedGiving,
      currency,
      confidence: 0.8,
      status: 'expected',
      href: '/planning/giving',
      sourceId: 'giving-year-end',
      actionId: null,
      planId: null,
      evidence: [],
      metadata: {
        plannedAnnualGiving: givingProfile.settings.plannedAnnualGiving,
        givenSoFar: givingPlan.currentYearTotal,
      },
    });
  }
  for (const donation of givingPlan.donations) {
    if (!donation.needsAcknowledgment) continue;
    const followUp = new Date(`${donation.date}T12:00:00Z`);
    followUp.setUTCDate(followUp.getUTCDate() + 30);
    const followUpDate = followUp.toISOString().slice(0, 10);
    if (followUpDate < today) continue;
    events.push({
      id: `giving:ack:${donation.id}:${followUpDate}`,
      bookGuid,
      domain: 'giving',
      title: `Acknowledgment letter — ${donation.charity}`,
      description: `Confirm the written acknowledgment for the ${donation.date} donation is on file.`,
      date: followUpDate,
      endDate: null,
      cashImpact: null,
      currency,
      confidence: 1,
      status: 'needs_action',
      href: '/planning/giving',
      sourceId: donation.id,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: { amount: donation.amount, kind: donation.kind },
    });
  }
  // --- End charitable giving section (events) ---
  // --- Estate readiness section (events) ---
  const estateReadiness = calculateEstateReadiness(estate as EstateProfile, now, await loadEstateRoster(bookGuid));
  const estateHorizon = new Date(now.getTime() + 365 * 86_400_000).toISOString().slice(0, 10);
  for (const document of estateReadiness.documents) {
    if (document.dueDate > estateHorizon) continue;
    const documentLabel = document.label || ESTATE_DOCUMENT_LABELS[document.kind];
    const owner = estateMemberDisplay(document.memberRole, document.memberName);
    events.push({
      id: `estate:document:${document.id}:${document.dueDate}`,
      bookGuid,
      domain: 'estate',
      title: `${documentLabel} review due — ${owner}`,
      description: `Last updated ${document.lastUpdatedDate}; kept at ${document.location || 'an unrecorded location'}.`,
      date: document.dueDate,
      endDate: null,
      cashImpact: 0,
      currency,
      confidence: 1,
      status: document.overdue ? 'needs_action' : 'expected',
      href: '/planning/estate',
      sourceId: document.id,
      actionId: null,
      planId: null,
      evidence: [],
      metadata: {
        kind: document.kind,
        lastUpdatedDate: document.lastUpdatedDate,
        reviewCycleYears: document.reviewCycleYears,
        memberRole: document.memberRole ?? 'household',
      },
    });
  }
  // --- End estate readiness section (events) ---
  // --- Farm production section (events) ---
  const farmResults = calculateFarmProduction(farmProduction as FarmProductionProfile, now);
  if (farmResults.marketDays) {
    for (const marketDate of farmResults.marketDays.nextDates) {
      events.push({
        id: `farm:market:${marketDate}`,
        bookGuid,
        domain: 'farm',
        title: 'Farmers market day',
        description: farmResults.marketDays.marketDaysThisYear > 0
          ? `Averaging ${farmResults.marketDays.averageRevenuePerMarketDay.toFixed(2)} per market day across ${farmResults.marketDays.marketDaysThisYear} market day${farmResults.marketDays.marketDaysThisYear === 1 ? '' : 's'} this year.`
          : 'No farmers-market sales recorded yet this year.',
        date: marketDate,
        endDate: null,
        cashImpact: farmResults.marketDays.averageRevenuePerMarketDay,
        currency,
        confidence: 0.5,
        status: 'expected',
        href: '/business/farm-production',
        sourceId: `market-${marketDate}`,
        actionId: null,
        planId: null,
        evidence: [],
        metadata: {
          dayOfWeek: farmResults.marketDays.dayOfWeek,
          marketDaysThisYear: farmResults.marketDays.marketDaysThisYear,
        },
      });
    }
  }
  // --- End farm production section (events) ---
  // --- Retirement income section (events) ---
  const retirementAnalysis = analyzeRetirementIncome(retirementIncome as RetirementIncomeProfile, now);
  for (const person of retirementAnalysis.people) {
    const rmdContext = retirementAnalysis.rmd.find(row => row.personId === person.personId);
    // Claim-eligibility milestones: 62, FRA, 70, RMD start, and the planned
    // claim age. Birthdays are only known to the year, so milestone dates are
    // approximated as July 1 (FRA rounds to the nearest whole year of age).
    const milestoneAges = new Map<number, string>();
    milestoneAges.set(EARLIEST_CLAIM_AGE, `${person.name} becomes eligible to claim Social Security`);
    milestoneAges.set(Math.round(person.fraMonths / 12), `${person.name} reaches full retirement age (${person.fraLabel})`);
    milestoneAges.set(LATEST_CLAIM_AGE, `${person.name} reaches age 70 — delayed credits stop`);
    if (rmdContext) {
      milestoneAges.set(rmdContext.rmdStartAge, `${person.name} reaches RMD start age ${rmdContext.rmdStartAge}`);
    }
    if (!milestoneAges.has(person.plannedClaimAge)) {
      milestoneAges.set(person.plannedClaimAge, `${person.name} plans to claim Social Security at ${person.plannedClaimAge}`);
    }
    for (const [age, title] of [...milestoneAges.entries()].sort((a, b) => a[0] - b[0])) {
      if (age > retirementAnalysis.settings.horizonAge) continue;
      const milestoneDate = `${person.birthYear + age}-07-01`;
      if (milestoneDate < today) continue;
      const isPlannedClaim = age === person.plannedClaimAge && person.plannedAnnualBenefit > 0;
      events.push({
        id: `retirement:milestone:${person.personId}:${age}`,
        bookGuid,
        domain: 'retirement',
        title,
        description: isPlannedClaim
          ? `Planned claim: about ${person.plannedMonthlyBenefit.toFixed(2)} per month before COLAs.`
          : null,
        date: milestoneDate,
        endDate: null,
        cashImpact: isPlannedClaim ? person.plannedAnnualBenefit : 0,
        currency,
        confidence: 0.7,
        status: 'expected',
        href: '/planning/retirement-income',
        sourceId: person.personId,
        actionId: null,
        planId: null,
        evidence: [],
        metadata: { age, birthYear: person.birthYear, plannedClaimAge: person.plannedClaimAge },
      });
    }
  }
  // --- End retirement income section (events) ---
  return events;
}

export function newId(): string {
  return randomUUID();
}
