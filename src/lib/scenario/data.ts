/**
 * Scenario Sandbox — baseline data loading.
 *
 * Builds the ScenarioBaseline the pure engine needs from the active book:
 * net worth + invested assets (FinancialSummaryService), trailing-12-month
 * income/expense run rates, current liquid (BANK+CASH) balance, and
 * annualized federal tax inputs (reusing the withholding tool's
 * book → engine-inputs mapping). No projection math lives here.
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getAccountGuidsForBook, getBookAccountGuids } from '@/lib/book-scope';
import { getBaseCurrency, getBaseCurrencyForBook } from '@/lib/currency';
import { getPreference } from '@/lib/user-preferences';
import { FinancialSummaryService } from '@/lib/services/financial-summary.service';
import { aggregateBookTaxData } from '@/lib/tax/book-income';
import { annualizeInputs, buildFederalInputsFromBook } from '@/lib/withholding';
import { FILING_STATUSES, type FilingStatus } from '@/lib/tax/types';
import { toTaxYear } from './engine';
import type { ScenarioBaseline } from './types';

const LIQUID_ACCOUNT_TYPES = ['BANK', 'CASH'];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sum current balances of non-hidden BANK/CASH accounts in the book. */
async function loadLiquidBalance(bookAccountGuids: string[], asOf: Date): Promise<number> {
  if (bookAccountGuids.length === 0) return 0;

  const accounts = await prisma.accounts.findMany({
    where: {
      guid: { in: bookAccountGuids },
      account_type: { in: LIQUID_ACCOUNT_TYPES },
      hidden: 0,
    },
    select: { guid: true },
  });
  const guids = accounts.map(a => a.guid);
  if (guids.length === 0) return 0;

  const rows = await prisma.$queryRaw<Array<{ balance: unknown }>>`
    SELECT SUM(CAST(s.quantity_num AS numeric) / NULLIF(s.quantity_denom, 0)) AS balance
    FROM splits s
    JOIN transactions t ON t.guid = s.tx_guid
    WHERE s.account_guid IN (${Prisma.join(guids)})
      AND t.post_date <= ${asOf}
  `;
  const value = parseFloat(String(rows[0]?.balance ?? '0'));
  return Number.isFinite(value) ? value : 0;
}

function ageFromBirthday(birthday: string | null, asOf: Date): number | null {
  if (!birthday) return null;
  const parsed = new Date(`${birthday}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  const years = Math.floor((asOf.getTime() - parsed.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return years > 0 && years < 120 ? years : null;
}

function isAge65PlusAtYearEnd(birthday: string | null, year: number): boolean {
  if (!birthday) return false;
  const birthYear = parseInt(birthday.slice(0, 4), 10);
  if (!Number.isFinite(birthYear)) return false;
  const parsed = new Date(`${birthday}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  const yearEnd = new Date(year, 11, 31);
  let age = yearEnd.getFullYear() - parsed.getFullYear();
  const beforeBirthday =
    yearEnd.getMonth() < parsed.getMonth() ||
    (yearEnd.getMonth() === parsed.getMonth() && yearEnd.getDate() < parsed.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 65;
}

function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Build the full baseline for the scenario engine from an explicit book when
 * provided, otherwise from the active book, plus the user's tax preferences.
 */
export async function buildScenarioBaseline(
  userId: number,
  bookGuid?: string,
): Promise<ScenarioBaseline> {
  const now = new Date();
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const calendarYear = now.getFullYear();
  const currentTaxYear = toTaxYear(calendarYear);
  const nextTaxYear = toTaxYear(calendarYear + 1);

  const bookAccountGuids = bookGuid
    ? await getAccountGuidsForBook(bookGuid)
    : await getBookAccountGuids();

  const [filingStatusPref, statePref, flatRatePref, birthday, baseCurrency] = await Promise.all([
    getPreference<string>(userId, 'tax_filing_status', 'single'),
    getPreference<string>(userId, 'tax_state', 'OTHER'),
    getPreference<number>(userId, 'tax_state_flat_rate', 0),
    getPreference<string | null>(userId, 'birthday', null),
    bookGuid ? getBaseCurrencyForBook(bookGuid) : getBaseCurrency(),
  ]);

  const filingStatus: FilingStatus = (FILING_STATUSES as readonly string[]).includes(
    filingStatusPref,
  )
    ? (filingStatusPref as FilingStatus)
    : 'single';

  const [netWorthSummary, incomeExpense, liquidBalance, bookData] = await Promise.all([
    FinancialSummaryService.computeNetWorthSummary(bookAccountGuids, yearAgo, now, baseCurrency),
    FinancialSummaryService.computeIncomeExpenses(bookAccountGuids, yearAgo, now, baseCurrency),
    loadLiquidBalance(bookAccountGuids, now),
    aggregateBookTaxData(bookAccountGuids, calendarYear, birthday),
  ]);

  const monthlyIncome = incomeExpense.totalIncome / 12;
  const monthlyExpenses = incomeExpense.totalExpenses / 12;
  const monthlyNet = monthlyIncome - monthlyExpenses;
  const savingsRatePct = FinancialSummaryService.computeSavingsRate(
    incomeExpense.totalIncome,
    incomeExpense.totalExpenses,
  );

  const filersAge65Plus = isAge65PlusAtYearEnd(birthday, calendarYear) ? 1 : 0;
  const ytdInputs = buildFederalInputsFromBook(
    bookData,
    currentTaxYear,
    filingStatus,
    filersAge65Plus,
  );
  const annualizeFactor =
    bookData.elapsedYearFraction < 1 ? 1 / bookData.elapsedYearFraction : 1;
  const federalInputsCurrentYear = annualizeInputs(ytdInputs, annualizeFactor);
  const federalInputsNextYear = { ...federalInputsCurrentYear, year: nextTaxYear };

  return {
    asOfDate: toIsoDate(now),
    netWorth: round2(netWorthSummary.end.netWorth),
    liquidBalance: round2(liquidBalance),
    investedAssets: round2(netWorthSummary.end.investmentValue),
    monthlyIncome: round2(monthlyIncome),
    monthlyExpenses: round2(monthlyExpenses),
    monthlyNet: round2(monthlyNet),
    savingsRatePct: round2(savingsRatePct),
    filingStatus,
    state: statePref || 'OTHER',
    stateFlatRatePct: typeof flatRatePref === 'number' ? flatRatePref : 0,
    currentAge: ageFromBirthday(birthday, now),
    currentTaxYear,
    nextTaxYear,
    federalInputsCurrentYear,
    federalInputsNextYear,
  };
}
