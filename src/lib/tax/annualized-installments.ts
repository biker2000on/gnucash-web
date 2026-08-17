/**
 * Form 2210 Schedule AI — annualized income installment method (pure).
 *
 * For lumpy income (a December stock sale, seasonal farm revenue), the even
 * 25/50/75/100% installment schedule front-loads payments the taxpayer does
 * not owe yet. Schedule AI recomputes each installment from income actually
 * received through the period end, annualized:
 *
 *   period ends   Mar 31   May 31   Aug 31   Dec 31
 *   annualization    4       2.4      1.5      1
 *   applicable %   22.5%     45%     67.5%     90%
 *
 * The caller supplies each column's ANNUALIZED total tax after credits (the
 * Schedule AI Part I tax line — computed by running the ordinary federal
 * engine over period actuals scaled by the annualization factor). This module
 * owns the form's column arithmetic (lines 21-27 of the 2210 Schedule AI):
 *
 *   line 21 = annualized tax x applicable %
 *   line 22 = sum of prior columns' line 27 (chosen installments)
 *   line 23 = max(0, line 21 - line 22)              — annualized installment
 *   line 24 = 25% of the required annual payment (Form 2210 line 9)
 *   line 25 = prior column's line 26 - line 27       — regular-schedule recapture
 *   line 26 = line 24 + line 25
 *   line 27 = min(line 23, line 26)                  — required installment
 *
 * The recapture (line 25) is what makes a relieved early quarter catch up
 * later instead of vanishing: the sum of line 27 across all four columns can
 * never exceed the required annual payment.
 *
 * Columns whose period has not ended yet have no actuals to annualize; they
 * fall back to the regular schedule (line 27 = line 26), claiming no benefit.
 *
 * Documented simplifications (also stated on the tracker surface):
 * - SE tax inside the annualized tax is computed on annualized SE income
 *   against the FULL Social Security wage base rather than Schedule AI Part
 *   II's prorated per-period base — identical below the cap.
 * - Withholding stays credited evenly across installments (the Form 2210
 *   default the tracker already uses); the actual-date withholding election
 *   is not modeled.
 * - Retirement contributions and linked-business profit are treated as
 *   accruing evenly through the year.
 *
 * A qualifying farmer (IRC 6654(i)) has a single Jan 15 installment;
 * Schedule AI does not apply — `compute` returns applicable: false.
 */

export const ANNUALIZATION_PERIOD_ENDS = ['03-31', '05-31', '08-31', '12-31'] as const;
export const ANNUALIZATION_FACTORS = [4, 2.4, 1.5, 1] as const;
export const APPLICABLE_PERCENTAGES = [0.225, 0.45, 0.675, 0.9] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AnnualizedInstallmentsInput {
  /** Form 2210 line 9 — the safe-harbor required annual payment. */
  requiredAnnualPayment: number;
  /**
   * Per-column annualized total tax AFTER credits (Schedule AI Part I tax
   * line), index 0 = period ending Mar 31. `null` = period not yet ended
   * (no actuals) — that column falls back to the regular schedule.
   */
  annualizedTaxByColumn: readonly [number | null, number | null, number | null, number | null];
  /** IRC 6654(i) single-installment election — Schedule AI does not apply. */
  isQualifyingFarmer?: boolean;
}

export interface AnnualizedColumn {
  quarter: 1 | 2 | 3 | 4;
  /** Period end month-day (MM-DD); the caller owns the year. */
  periodEnd: string;
  annualizationFactor: number;
  applicablePercent: number;
  /** Annualized total tax after credits, or null when the period hasn't ended. */
  annualizedTax: number | null;
  /** line 21: annualizedTax x applicablePercent. */
  aiCumulative: number | null;
  /** line 23: this column's annualized installment. */
  aiInstallment: number | null;
  /** line 24: requiredAnnualPayment / 4. */
  regularInstallment: number;
  /** line 25: prior column's unclaimed regular amount. */
  recaptureFromPrior: number;
  /** line 26: regularInstallment + recaptureFromPrior. */
  regularWithRecapture: number;
  /** line 27: the required installment for this column. */
  chosenInstallment: number;
  /** Running sum of chosenInstallment. */
  chosenCumulative: number;
  methodUsed: 'annualized' | 'regular';
}

export interface AnnualizedInstallmentsResult {
  /** False when the farmer election applies (single Jan 15 installment). */
  applicable: boolean;
  columns: AnnualizedColumn[];
  /** Cumulative required by quarter — feeds the quarter tracker directly. */
  requiredCumulativeByQuarter: [number, number, number, number];
  /** True when any column's requirement is below the regular schedule's. */
  anyBenefit: boolean;
}

export function computeAnnualizedInstallments(
  input: AnnualizedInstallmentsInput,
): AnnualizedInstallmentsResult {
  const rap = Math.max(0, input.requiredAnnualPayment);
  const regular = round2(rap / 4);

  if (input.isQualifyingFarmer) {
    return {
      applicable: false,
      columns: [],
      // Qualifying farmers/fishers have a single Jan. 15 installment; the
      // API supplies [0, 0, 0, rap] directly to the quarter tracker.
      requiredCumulativeByQuarter: [0, 0, 0, rap],
      anyBenefit: false,
    };
  }

  const columns: AnnualizedColumn[] = [];
  let priorChosenTotal = 0; // line 22 feed
  let recapture = 0;        // line 25 feed
  let anyBenefit = false;

  for (let i = 0; i < 4; i++) {
    const annualizedTax = input.annualizedTaxByColumn[i];
    const aiCumulative = annualizedTax === null ? null : round2(annualizedTax * APPLICABLE_PERCENTAGES[i]);
    const aiInstallment = aiCumulative === null ? null : round2(Math.max(0, aiCumulative - priorChosenTotal));
    const regularWithRecapture = round2(regular + recapture);
    const chosenInstallment = aiInstallment === null
      ? regularWithRecapture
      : round2(Math.min(aiInstallment, regularWithRecapture));
    const methodUsed: AnnualizedColumn['methodUsed'] =
      aiInstallment !== null && aiInstallment < regularWithRecapture ? 'annualized' : 'regular';
    if (methodUsed === 'annualized') anyBenefit = true;

    columns.push({
      quarter: (i + 1) as 1 | 2 | 3 | 4,
      periodEnd: ANNUALIZATION_PERIOD_ENDS[i],
      annualizationFactor: ANNUALIZATION_FACTORS[i],
      applicablePercent: APPLICABLE_PERCENTAGES[i],
      annualizedTax: annualizedTax === null ? null : round2(annualizedTax),
      aiCumulative,
      aiInstallment,
      regularInstallment: regular,
      recaptureFromPrior: recapture,
      regularWithRecapture,
      chosenInstallment,
      chosenCumulative: round2(priorChosenTotal + chosenInstallment),
      methodUsed,
    });

    recapture = round2(regularWithRecapture - chosenInstallment);
    priorChosenTotal = round2(priorChosenTotal + chosenInstallment);
  }

  return {
    applicable: true,
    columns,
    requiredCumulativeByQuarter: [
      columns[0].chosenCumulative,
      columns[1].chosenCumulative,
      columns[2].chosenCumulative,
      columns[3].chosenCumulative,
    ],
    anyBenefit,
  };
}
