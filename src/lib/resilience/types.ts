export type ResilienceSection =
  | 'rentals'
  | 'insurance'
  | 'capital'
  | 'life'
  | 'healthcare'
  | 'mileage'
  | 'fuel';

export interface RentalPayment {
  id: string;
  date: string;
  amount: number;
  kind: 'rent' | 'deposit' | 'late_fee' | 'credit';
  transactionGuid?: string | null;
  note?: string | null;
}
export interface RentalUnit {
  id: string;
  name: string;
  tenantName: string;
  tenantEmail?: string | null;
  leaseStart: string;
  leaseEnd: string;
  monthlyRent: number;
  rentDueDay: number;
  securityDeposit: number;
  lateFee: number;
  annualEscalationPercent: number;
  payments: RentalPayment[];
}

export interface RentalProperty {
  id: string;
  name: string;
  address: string;
  scheduleEPropertyId?: string | null;
  units: RentalUnit[];
}

export interface RentalsProfile {
  properties: RentalProperty[];
}

export type InsurancePolicyType = 'home' | 'renters' | 'auto' | 'umbrella' | 'life' | 'health' | 'other';

export interface InsuranceSublimit {
  id: string;
  category: string;
  limit: number;
}

export interface InsurancePolicy {
  id: string;
  type: InsurancePolicyType;
  provider: string;
  policyNumber: string;
  coveredEntity: string;
  coverageLimit: number;
  deductible: number;
  annualPremium: number;
  renewalDate: string;
  sublimits: InsuranceSublimit[];
  documentIds: number[];
}

export interface InsuranceProfile {
  policies: InsurancePolicy[];
}

export interface CapitalAsset {
  id: string;
  name: string;
  category: string;
  installedYear: number;
  expectedLifeYears: number;
  currentReplacementCost: number;
  inflationRate: number;
  fundedAmount: number;
  linkedHomeItemId?: number | null;
}

export interface CapitalProfile {
  assets: CapitalAsset[];
}

export interface LifePerson {
  id: string;
  name: string;
  annualIncome: number;
  replacementYears: number;
  debts: number;
  educationGoals: number;
  finalExpenses: number;
  liquidAssets: number;
  existingCoverage: number;
  survivorAnnualIncome: number;
  survivorAnnualExpenses: number;
}

export interface LifeProfile {
  people: LifePerson[];
}

export interface HealthcareClaim {
  id: string;
  date: string;
  member: string;
  category: string;
  allowedAmount: number;
}

export interface HealthcarePlan {
  id: string;
  name: string;
  annualPremium: number;
  familyDeductible: number;
  coinsurancePercent: number;
  outOfPocketMax: number;
  employerHsaContribution: number;
  employeeHsaContribution: number;
  marginalTaxRate: number;
  hsaEligible: boolean;
}

export interface HealthcareProfile {
  currentPlanId?: string | null;
  plans: HealthcarePlan[];
  claims: HealthcareClaim[];
}

export type MileagePurpose = 'business' | 'medical' | 'charity' | 'personal';
export type MileageSchedule = 'C' | 'E' | 'F' | 'none';

export interface MileageVehicle {
  id: string;
  name: string;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  fuelTrackerVehicleId?: string | null;
}

export interface MileageTrip {
  id: string;
  date: string;
  vehicleId: string;
  purpose: MileagePurpose;
  schedule: MileageSchedule;
  description: string;
  miles: number;
  startOdometer?: number | null;
  endOdometer?: number | null;
}

export interface MileageProfile {
  vehicles: MileageVehicle[];
  trips: MileageTrip[];
}

export interface FuelFillup {
  sourceId: string;
  sourceVehicleId: string;
  vehicleId?: string | null;
  date: string;
  gallons: number;
  pricePerGallon: number;
  totalCost: number;
  odometer?: number | null;
  mpg?: number | null;
  location?: string | null;
  transactionGuid?: string | null;
  matchStatus: 'unmatched' | 'matched' | 'ignored';
}

export interface FuelProfile {
  baseUrl: string;
  enabled: boolean;
  hasToken: boolean;
  lastSyncAt?: string | null;
  vehicles: Array<{
    sourceId: string;
    name: string;
    year?: number | null;
    make?: string | null;
    model?: string | null;
    mappedVehicleId?: string | null;
  }>;
  fillups: FuelFillup[];
}

export interface ReceiptPriceObservation {
  receiptId: number;
  date: string;
  merchant: string | null;
  rawName: string;
  normalizedName: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface PersonalPriceIndexItem {
  normalizedName: string;
  latestName: string;
  observations: number;
  firstDate: string;
  latestDate: string;
  firstUnitPrice: number;
  latestUnitPrice: number;
  changePercent: number;
  annualizedPercent: number | null;
  receiptIds: number[];
}
