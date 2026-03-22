/**
 * Mortgage Detection Service
 *
 * Core mortgage analysis logic:
 * - Detecting original loan amount from GnuCash splits
 * - Separating payment splits into principal vs interest
 * - Reverse-engineering interest rate using Newton-Raphson method
 */

import prisma from '@/lib/prisma';
import { toDecimal } from '@/lib/gnucash';

/**
 * A single payment broken into principal and interest components
 */
export interface PaymentSplit {
  date: Date;
  principal: number;
  interest: number;
  total: number;
}

/**
 * Result of interest rate detection via Newton-Raphson
 */
export interface RateDetectionResult {
  rate: number;
  converged: boolean;
}

/**
 * Confidence level for mortgage detection
 */
export type DetectionConfidence = 'high' | 'medium' | 'low';

/**
 * Full mortgage detection result
 */
export interface MortgageDetectionResult {
  originalAmount: number;
  interestRate: number;
  monthlyPayment: number;
  paymentsAnalyzed: number;
  confidence: DetectionConfidence;
  warnings: string[];
}

/**
 * Service class for mortgage detection and analysis
 */
export class MortgageService {
  /**
   * Separate transaction splits into principal vs interest components.
   *
   * Principal = splits posting to the mortgage liability account
   * Interest = splits posting to the interest expense account
   * Escrow and other splits are excluded.
   *
   * Groups by transaction date and returns an array of PaymentSplit.
   */
  static separateSplits(
    splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint | number | string;
      value_denom: bigint | number | string;
      post_date: Date;
    }>,
    mortgageAccountGuid: string,
    interestAccountGuid: string
  ): PaymentSplit[] {
    // Group splits by transaction
    const txMap = new Map<
      string,
      { date: Date; principal: number; interest: number }
    >();

    for (const split of splits) {
      const value = parseFloat(toDecimal(split.value_num, split.value_denom));

      // Only consider splits posting to mortgage or interest accounts
      if (
        split.account_guid !== mortgageAccountGuid &&
        split.account_guid !== interestAccountGuid
      ) {
        continue;
      }

      let entry = txMap.get(split.tx_guid);
      if (!entry) {
        entry = { date: split.post_date, principal: 0, interest: 0 };
        txMap.set(split.tx_guid, entry);
      }

      if (split.account_guid === mortgageAccountGuid) {
        // Principal payment reduces the liability (positive value = paying down)
        entry.principal += Math.abs(value);
      } else if (split.account_guid === interestAccountGuid) {
        // Interest expense
        entry.interest += Math.abs(value);
      }
    }

    // Convert to array sorted by date
    const payments: PaymentSplit[] = [];
    for (const entry of txMap.values()) {
      payments.push({
        date: entry.date,
        principal: entry.principal,
        interest: entry.interest,
        total: entry.principal + entry.interest,
      });
    }

    payments.sort((a, b) => a.date.getTime() - b.date.getTime());
    return payments;
  }

  /**
   * Detect the original loan amount.
   *
   * Strategy 1: Look for the first/largest posting to the liability account
   * (opening balance transaction).
   * Strategy 2 (fallback): Sum all principal postings.
   */
  static detectOriginalAmount(
    splits: Array<{
      tx_guid: string;
      account_guid: string;
      value_num: bigint | number | string;
      value_denom: bigint | number | string;
      post_date: Date;
    }>,
    mortgageAccountGuid: string
  ): number {
    // Filter to splits posting to the mortgage account
    const mortgageSplits = splits
      .filter((s) => s.account_guid === mortgageAccountGuid)
      .map((s) => ({
        ...s,
        value: parseFloat(toDecimal(s.value_num, s.value_denom)),
      }))
      .sort((a, b) => a.post_date.getTime() - b.post_date.getTime());

    if (mortgageSplits.length === 0) return 0;

    // Strategy 1: The first/largest posting is likely the opening balance.
    // In GnuCash, the opening balance for a liability is typically negative
    // (credit to the liability account). We look for the largest absolute value
    // among the earliest transactions.
    const firstDate = mortgageSplits[0].post_date.getTime();
    const openingSplits = mortgageSplits.filter(
      (s) => s.post_date.getTime() === firstDate
    );

    // Find the largest absolute value on the first date
    let maxAbsValue = 0;
    for (const s of openingSplits) {
      const absVal = Math.abs(s.value);
      if (absVal > maxAbsValue) {
        maxAbsValue = absVal;
      }
    }

    // If the largest opening split is significantly larger than subsequent splits,
    // it's likely the opening balance
    if (mortgageSplits.length > 1) {
      const subsequentValues = mortgageSplits
        .filter((s) => s.post_date.getTime() !== firstDate)
        .map((s) => Math.abs(s.value));

      if (subsequentValues.length > 0) {
        const avgSubsequent =
          subsequentValues.reduce((a, b) => a + b, 0) / subsequentValues.length;

        // If opening is at least 3x the average subsequent payment, use it
        if (maxAbsValue > avgSubsequent * 3) {
          return maxAbsValue;
        }
      } else {
        // Only one date of transactions, return the max
        return maxAbsValue;
      }
    } else {
      return maxAbsValue;
    }

    // Strategy 2 (fallback): Sum all principal postings
    const totalPrincipal = mortgageSplits.reduce(
      (sum, s) => sum + Math.abs(s.value),
      0
    );
    return totalPrincipal;
  }

  /**
   * Detect the interest rate using Newton-Raphson method.
   *
   * Solves: M = P * r(1+r)^n / ((1+r)^n - 1) for monthly rate r
   * Returns annual rate = r * 12 * 100
   *
   * @param originalAmount - Original loan principal (P)
   * @param monthlyPayment - Monthly payment amount (M)
   * @param totalPayments - Total number of payments (n)
   * @returns Rate detection result with annual percentage and convergence status
   */
  static detectInterestRate(
    originalAmount: number,
    monthlyPayment: number,
    totalPayments: number
  ): RateDetectionResult {
    if (totalPayments < 3) {
      return { rate: 0, converged: false };
    }

    if (originalAmount <= 0 || monthlyPayment <= 0) {
      return { rate: 0, converged: false };
    }

    // If monthly payment * totalPayments <= original amount, no interest
    if (monthlyPayment * totalPayments <= originalAmount) {
      return { rate: 0, converged: true };
    }

    // Newton-Raphson to find monthly rate r
    // f(r) = M - P * r * (1+r)^n / ((1+r)^n - 1) = 0
    let r = 0.04 / 12; // Initial guess: 4% annual
    const maxIterations = 100;
    const tolerance = 0.01;
    const P = originalAmount;
    const M = monthlyPayment;
    const n = totalPayments;

    for (let i = 0; i < maxIterations; i++) {
      const rn = Math.pow(1 + r, n); // (1+r)^n
      const f = M - (P * r * rn) / (rn - 1);

      // Check convergence
      if (Math.abs(f) < tolerance) {
        return { rate: r * 12 * 100, converged: true };
      }

      // Derivative of f with respect to r:
      // f'(r) = -P * [ (rn*(rn - 1) - r*n*(1+r)^(n-1)*(rn-1) + r*rn*n*(1+r)^(n-1)) / (rn-1)^2 ]
      // Simplified: f'(r) = -P * [ rn / (rn-1) + r*n*(1+r)^(n-1) * (1/(rn-1) - rn/(rn-1)^2) ]
      // Let's compute numerically for clarity
      const rn1 = Math.pow(1 + r, n - 1); // (1+r)^(n-1)
      const denom = rn - 1;
      const denom2 = denom * denom;

      // d/dr [r * rn / (rn - 1)]
      // = [rn + r * n * rn1] * (rn - 1) - r * rn * n * rn1
      // all over (rn - 1)^2
      // = [rn * (rn - 1) + r * n * rn1 * (rn - 1) - r * rn * n * rn1] / (rn - 1)^2
      // = [rn * (rn - 1) + r * n * rn1 * (rn - 1 - rn)] / (rn - 1)^2
      // = [rn * (rn - 1) - r * n * rn1] / (rn - 1)^2
      const numerator = rn * denom - r * n * rn1;
      const df = -P * numerator / denom2;

      if (Math.abs(df) < 1e-15) {
        return { rate: r * 12 * 100, converged: false };
      }

      const rNew = r - f / df;

      // Ensure rate stays positive and reasonable
      if (rNew <= 0) {
        r = r / 2;
      } else if (rNew > 1) {
        r = 0.5; // Cap at 50% monthly
      } else {
        r = rNew;
      }
    }

    // Did not converge
    return { rate: r * 12 * 100, converged: false };
  }

  /**
   * Full pipeline: query DB for splits, separate, detect amount, detect rate.
   *
   * @param mortgageAccountGuid - GUID of the mortgage liability account
   * @param interestAccountGuid - GUID of the interest expense account
   * @returns Full mortgage detection result
   */
  static async detectMortgageDetails(
    mortgageAccountGuid: string,
    interestAccountGuid: string
  ): Promise<MortgageDetectionResult> {
    const warnings: string[] = [];

    // Query all splits for both the mortgage and interest accounts, joined with transaction dates
    const splits = await prisma.splits.findMany({
      where: {
        account_guid: {
          in: [mortgageAccountGuid, interestAccountGuid],
        },
      },
      include: {
        transaction: {
          select: {
            post_date: true,
          },
        },
      },
      orderBy: {
        transaction: {
          post_date: 'asc',
        },
      },
    });

    // Transform splits to include post_date at the top level
    const enrichedSplits = splits.map((s) => ({
      tx_guid: s.tx_guid,
      account_guid: s.account_guid,
      value_num: s.value_num,
      value_denom: s.value_denom,
      post_date: s.transaction!.post_date!,
    }));

    // Separate into principal and interest
    const payments = MortgageService.separateSplits(
      enrichedSplits,
      mortgageAccountGuid,
      interestAccountGuid
    );

    // Detect original amount
    const originalAmount = MortgageService.detectOriginalAmount(
      enrichedSplits,
      mortgageAccountGuid
    );

    // Calculate average monthly payment (from payments that have both principal and interest)
    const regularPayments = payments.filter(
      (p) => p.principal > 0 && p.interest > 0
    );
    const monthlyPayment =
      regularPayments.length > 0
        ? regularPayments.reduce((sum, p) => sum + p.total, 0) /
          regularPayments.length
        : 0;

    // Estimate total payments (assume 30-year mortgage if we can't determine)
    const totalPayments = 360;

    // Detect interest rate
    const rateResult = MortgageService.detectInterestRate(
      originalAmount,
      monthlyPayment,
      totalPayments
    );

    // Check for variable rate by computing implied rates from individual payments
    if (regularPayments.length >= 3) {
      const individualRates: number[] = [];
      let remainingBalance = originalAmount;

      for (const payment of regularPayments) {
        if (remainingBalance > 0) {
          const impliedMonthlyRate = payment.interest / remainingBalance;
          individualRates.push(impliedMonthlyRate * 12 * 100);
          remainingBalance -= payment.principal;
        }
      }

      if (individualRates.length >= 3) {
        const avgRate =
          individualRates.reduce((a, b) => a + b, 0) / individualRates.length;
        const maxDeviation = Math.max(
          ...individualRates.map((r) => Math.abs(r - avgRate))
        );

        if (maxDeviation > 0.5) {
          warnings.push('Variable rate detected');
        }
      }
    }

    // Determine confidence
    let confidence: DetectionConfidence;
    if (regularPayments.length > 10) {
      // Check payment variance
      const paymentAmounts = regularPayments.map((p) => p.total);
      const avgPayment =
        paymentAmounts.reduce((a, b) => a + b, 0) / paymentAmounts.length;
      const maxVariance = Math.max(
        ...paymentAmounts.map((p) => Math.abs(p - avgPayment) / avgPayment)
      );

      confidence = maxVariance < 0.001 ? 'high' : 'medium';
    } else if (regularPayments.length >= 3) {
      confidence = 'medium';
    } else {
      confidence = 'low';
      if (regularPayments.length < 3) {
        warnings.push('Insufficient data');
      }
    }

    return {
      originalAmount,
      interestRate: rateResult.rate,
      monthlyPayment,
      paymentsAnalyzed: payments.length,
      confidence,
      warnings,
    };
  }
}

export default MortgageService;
