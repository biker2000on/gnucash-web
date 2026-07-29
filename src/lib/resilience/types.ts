export type ResilienceSection =
  | 'rentals'
  | 'insurance'
  | 'capital'
  | 'life'
  | 'healthcare'
  | 'mileage'
  | 'fuel'
  | 'education'
  | 'utilities'
  | 'family_banking'
  | 'trips'
  | 'vehicle_tco';

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

export interface EducationContribution {
  id: string;
  date: string;
  amount: number;
}

export interface EducationChild {
  id: string;
  name: string;
  birthYear: number;
  collegeStartYear: number;
  schoolType: 'public_in_state' | 'public_out_of_state' | 'private';
  yearsOfSchool: number;
  annualCostToday: number;
  tuitionInflationRate: number;
  current529Balance: number;
  expectedAnnualReturn: number;
  plannedMonthlyContribution: number;
  stateDeductionLimit: number;
  contributions: EducationContribution[];
}

export interface EducationProfile {
  children: EducationChild[];
}

export type UtilityType = 'electric' | 'gas' | 'water';

export interface UtilityBill {
  id: string;
  date: string;
  type: UtilityType;
  provider: string;
  usage: number;
  unit: 'kWh' | 'therms' | 'gallons';
  totalCost: number;
  transactionGuid?: string | null;
  receiptId?: number | null;
}

export interface SolarScenario {
  enabled: boolean;
  systemCost: number;
  incentives: number;
  annualProductionKwh: number;
  degradationRate: number;
  electricRateInflation: number;
  annualMaintenance: number;
  analysisYears: number;
}

export interface UtilitiesProfile {
  bills: UtilityBill[];
  solar: SolarScenario;
}

export type FamilyBankEntryKind = 'allowance' | 'chore' | 'deposit' | 'spend' | 'match';

export interface FamilyBankEntry {
  id: string;
  date: string;
  description: string;
  amount: number;
  kind: FamilyBankEntryKind;
  approved: boolean;
  transactionGuid?: string | null;
}

export interface FamilyBankChild {
  id: string;
  name: string;
  liabilityAccountGuid: string;
  allowanceAmount: number;
  allowanceCadence: 'weekly' | 'monthly';
  nextAllowanceDate: string;
  parentMatchPercent: number;
  savingsGoal: number;
  entries: FamilyBankEntry[];
}

export interface FamilyBankingProfile {
  children: FamilyBankChild[];
}

export interface TripExpense {
  id: string;
  date: string;
  description: string;
  amount: number;
  transactionGuid?: string | null;
}

export interface TripPlan {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  budget: number;
  savingsTarget: number;
  fundedAmount: number;
  tagId?: number | null;
  tagName?: string | null;
  current: boolean;
  expenses: TripExpense[];
}

export interface TripsProfile {
  trips: TripPlan[];
}

export interface VehicleTcoAsset {
  id: string;
  mileageVehicleId?: string | null;
  name: string;
  purchaseDate: string;
  purchasePrice: number;
  currentValue: number;
  annualInsurance: number;
  annualRegistration: number;
  annualMaintenance: number;
  annualOther: number;
  repairCost: number;
  repairExtendsYears: number;
  replacementVehicleCost: number;
  replacementAnnualOperatingCost: number;
}

export interface VehicleTcoProfile {
  vehicles: VehicleTcoAsset[];
}
