/**
 * Generic Depreciation/Appreciation Calculator
 *
 * Pure calculation utility for generating depreciation or appreciation schedules.
 * Supports straight-line and declining-balance methods with configurable frequency.
 * No database interaction -- used by the asset transaction service for schedule generation.
 */

export interface DepreciationConfig {
  purchasePrice: number;
  purchaseDate: Date;
  salvageValue: number;
  usefulLifeYears: number;
  method: 'straight-line' | 'declining-balance';
  declineRate?: number; // For declining balance, default 2/usefulLife
  frequency: 'monthly' | 'quarterly' | 'yearly';
  isAppreciation?: boolean; // If true, values increase instead of decrease
}

export interface ScheduleEntry {
  date: Date;
  periodAmount: number; // Amount for this period (always positive)
  cumulativeAmount: number; // Total depreciation/appreciation to date
  bookValue: number; // Asset value after this period
}

/**
 * Returns the number of periods per year for a given frequency.
 */
function periodsPerYear(frequency: DepreciationConfig['frequency']): number {
  switch (frequency) {
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'yearly': return 1;
  }
}

/**
 * Advances a date by one period based on the frequency.
 */
function advanceDate(date: Date, frequency: DepreciationConfig['frequency']): Date {
  const next = new Date(date);
  switch (frequency) {
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'yearly':
      next.setFullYear(next.getFullYear() + 1);
      break;
  }
  return next;
}

/**
 * Calculates the per-period straight-line depreciation amount.
 */
function straightLinePeriodAmount(config: DepreciationConfig): number {
  const ppYear = periodsPerYear(config.frequency);
  const totalPeriods = config.usefulLifeYears * ppYear;
  if (totalPeriods === 0) return 0;
  const totalDepreciation = config.purchasePrice - config.salvageValue;
  return Math.abs(totalDepreciation) / totalPeriods;
}

/**
 * Calculate the asset value at a specific date.
 */
export function calculateValueAtDate(config: DepreciationConfig, asOfDate?: Date): number {
  const targetDate = asOfDate ?? new Date();
  const schedule = generateSchedule(config);

  // Find the last entry on or before the target date
  let value = config.purchasePrice;
  for (const entry of schedule) {
    if (entry.date <= targetDate) {
      value = entry.bookValue;
    } else {
      break;
    }
  }

  return value;
}

/**
 * Generate the full schedule of periodic depreciation/appreciation entries.
 */
export function generateSchedule(config: DepreciationConfig): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const ppYear = periodsPerYear(config.frequency);
  const totalPeriods = config.usefulLifeYears * ppYear;
  const isAppreciation = config.isAppreciation ?? false;

  if (totalPeriods === 0) return entries;

  let currentDate = advanceDate(new Date(config.purchaseDate), config.frequency);
  let bookValue = config.purchasePrice;
  let cumulativeAmount = 0;

  if (config.method === 'straight-line') {
    const periodAmt = straightLinePeriodAmount(config);

    for (let i = 0; i < totalPeriods; i++) {
      if (isAppreciation) {
        bookValue += periodAmt;
      } else {
        // Don't depreciate below salvage value
        const maxDepr = Math.max(0, bookValue - config.salvageValue);
        const actualAmount = Math.min(periodAmt, maxDepr);
        if (actualAmount <= 0) break;
        bookValue -= actualAmount;
        cumulativeAmount += actualAmount;

        entries.push({
          date: new Date(currentDate),
          periodAmount: actualAmount,
          cumulativeAmount,
          bookValue,
        });
        currentDate = advanceDate(currentDate, config.frequency);
        continue;
      }

      cumulativeAmount += periodAmt;
      entries.push({
        date: new Date(currentDate),
        periodAmount: periodAmt,
        cumulativeAmount,
        bookValue,
      });
      currentDate = advanceDate(currentDate, config.frequency);
    }
  } else {
    // Declining balance
    const rate = config.declineRate ?? (2 / config.usefulLifeYears);
    const periodRate = rate / ppYear;

    for (let i = 0; i < totalPeriods; i++) {
      if (isAppreciation) {
        const periodAmt = bookValue * periodRate;
        bookValue += periodAmt;
        cumulativeAmount += periodAmt;
      } else {
        const rawAmount = bookValue * periodRate;
        const maxDepr = Math.max(0, bookValue - config.salvageValue);
        const periodAmt = Math.min(rawAmount, maxDepr);
        if (periodAmt <= 0) break;
        bookValue -= periodAmt;
        cumulativeAmount += periodAmt;

        entries.push({
          date: new Date(currentDate),
          periodAmount: periodAmt,
          cumulativeAmount,
          bookValue,
        });
        currentDate = advanceDate(currentDate, config.frequency);
        continue;
      }

      entries.push({
        date: new Date(currentDate),
        periodAmount: cumulativeAmount - (entries.length > 0 ? entries[entries.length - 1].cumulativeAmount : 0),
        cumulativeAmount,
        bookValue,
      });
      currentDate = advanceDate(currentDate, config.frequency);
    }
  }

  return entries;
}

/**
 * Calculate the depreciation/appreciation amount for a specific period.
 * Returns 0 if the date is outside the schedule range.
 */
export function getPeriodAmount(config: DepreciationConfig, periodDate: Date): number {
  const schedule = generateSchedule(config);

  // Find the entry closest to the period date
  for (const entry of schedule) {
    // Match by year/month for monthly, year/quarter for quarterly, year for yearly
    if (datesMatchPeriod(entry.date, periodDate, config.frequency)) {
      return entry.periodAmount;
    }
  }

  return 0;
}

/**
 * Check if two dates fall in the same period.
 */
function datesMatchPeriod(a: Date, b: Date, frequency: DepreciationConfig['frequency']): boolean {
  switch (frequency) {
    case 'monthly':
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
    case 'quarterly':
      return a.getFullYear() === b.getFullYear() && Math.floor(a.getMonth() / 3) === Math.floor(b.getMonth() / 3);
    case 'yearly':
      return a.getFullYear() === b.getFullYear();
  }
}
