/**
 * IRMAA (Income-Related Monthly Adjustment Amount) — 2026 MAGI tiers and
 * estimated Medicare Part B + Part D surcharges per enrollee.
 *
 * 2026 premiums/thresholds per the CMS 2026 announcement (Part B standard
 * premium $202.90/mo; Part D IRMAA adders are estimates). MAGI here is
 * AGI + tax-exempt interest; the planner models no tax-exempt interest so
 * MAGI == AGI. The two-year lookback means MAGI from age 63 onward can set
 * premiums at 65+ — callers should only flag ages >= 63.
 *
 * Thresholds are expressed in 2026 dollars; the engine compares them
 * against MAGI deflated to 2026 dollars (equivalent to indexing the tiers
 * with the model's inflation rate).
 */

import type { FilingStatus } from '@/lib/tax/types';
import type { IrmaaFlag } from './types';

/** 2026 standard Part B monthly premium. */
export const PART_B_STANDARD_MONTHLY_2026 = 202.9;

interface IrmaaTierDef {
  /** MAGI must EXCEED this to land in the tier (2026 dollars). */
  singleAbove: number;
  mfjAbove: number;
  /** Part B premium multiplier (1.4, 2.0, 2.6, 3.2, 3.4). */
  partBMultiplier: number;
  /** Estimated 2026 Part D monthly IRMAA adder. */
  partDMonthly: number;
}

export const IRMAA_TIERS_2026: readonly IrmaaTierDef[] = [
  { singleAbove: 109_000, mfjAbove: 218_000, partBMultiplier: 1.4, partDMonthly: 14.5 },
  { singleAbove: 137_000, mfjAbove: 274_000, partBMultiplier: 2.0, partDMonthly: 37.5 },
  { singleAbove: 171_000, mfjAbove: 342_000, partBMultiplier: 2.6, partDMonthly: 60.4 },
  { singleAbove: 205_000, mfjAbove: 410_000, partBMultiplier: 3.2, partDMonthly: 83.3 },
  { singleAbove: 500_000, mfjAbove: 750_000, partBMultiplier: 3.4, partDMonthly: 91.0 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * IRMAA tier (1..5) for a MAGI expressed in 2026 dollars, or null when the
 * MAGI stays at or below the first threshold. MFJ/QSS use the joint table;
 * all other statuses use the single table (the MFS special schedule is not
 * modeled).
 */
export function irmaaTierFor(magi2026: number, filingStatus: FilingStatus): IrmaaFlag | null {
  const joint = filingStatus === 'mfj' || filingStatus === 'qss';
  let tier = 0;
  for (const def of IRMAA_TIERS_2026) {
    const threshold = joint ? def.mfjAbove : def.singleAbove;
    if (magi2026 > threshold) tier += 1;
    else break;
  }
  if (tier === 0) return null;

  const def = IRMAA_TIERS_2026[tier - 1];
  const threshold = joint ? def.mfjAbove : def.singleAbove;
  const partBSurcharge = PART_B_STANDARD_MONTHLY_2026 * (def.partBMultiplier - 1);
  const monthly = partBSurcharge + def.partDMonthly;
  return {
    tier,
    label: `> $${threshold.toLocaleString('en-US')}`,
    monthlySurcharge: round2(monthly),
    annualSurcharge: round2(monthly * 12),
  };
}
