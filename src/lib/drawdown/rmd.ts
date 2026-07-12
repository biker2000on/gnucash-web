/**
 * Required Minimum Distributions — SECURE 2.0 start ages and the IRS
 * Uniform Lifetime Table (the table in effect since 2022, Treas. Reg.
 * §1.401(a)(9)-9(c)). Used for account owners whose sole beneficiary is
 * not a spouse more than 10 years younger.
 */

/**
 * IRS Uniform Lifetime Table divisors by age. Ages below 72 never take
 * RMDs under current law; ages above 120 use the 120+ divisor.
 */
export const UNIFORM_LIFETIME_TABLE: Record<number, number> = {
  72: 27.4,
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22.0,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16.0,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4,
  101: 6.0,
  102: 5.6,
  103: 5.2,
  104: 4.9,
  105: 4.6,
  106: 4.3,
  107: 4.1,
  108: 3.9,
  109: 3.7,
  110: 3.5,
  111: 3.4,
  112: 3.3,
  113: 3.1,
  114: 3.0,
  115: 2.9,
  116: 2.8,
  117: 2.7,
  118: 2.5,
  119: 2.3,
  120: 2.0,
};

/**
 * SECURE 2.0 RMD start age:
 * - born 1960 or later → 75
 * - born 1951–1959    → 73
 * - born 1950 or earlier → 73 (they are already in RMD status under the
 *   pre-2023 rules; modeled at 73 so a backdated scenario still forces
 *   distributions)
 */
export function rmdStartAge(birthYear: number): number {
  return birthYear >= 1960 ? 75 : 73;
}

/** Uniform Lifetime Table divisor for an age (clamped to the 72–120 range). */
export function rmdDivisor(age: number): number {
  const clamped = Math.min(120, Math.max(72, Math.floor(age)));
  return UNIFORM_LIFETIME_TABLE[clamped];
}

/**
 * RMD for the year the owner turns `age`, based on the prior year-end
 * traditional balance. Returns 0 before the SECURE 2.0 start age.
 */
export function computeRmd(age: number, birthYear: number, priorYearEndBalance: number): number {
  if (age < rmdStartAge(birthYear)) return 0;
  if (priorYearEndBalance <= 0) return 0;
  return priorYearEndBalance / rmdDivisor(age);
}
