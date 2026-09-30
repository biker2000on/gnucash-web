/**
 * Compliance calendar — pure, client-safe deadline definitions.
 *
 * Generates the filing/payment/admin deadlines an entity owes for a given
 * CALENDAR year: the items you act on during `year`. That means annual
 * filings due in `year` cover the PRIOR tax year (you file your 2025 Form
 * 1040 on April 15, 2026), while quarterly payment schedules belong to the
 * tax year they fund — so a year's Q4 items (1040-ES, Form 941) fall due in
 * January of `year + 1`, exactly as the IRS schedules them.
 *
 * Rule sets are federal (US) plus North Carolina where the entity's tax
 * state is NC. Item `key` + `period` together identify a deadline for
 * status tracking in gnucash_web_compliance_status (period is '2026' for
 * annual items, '2026-Q3' for quarterlies).
 *
 * No database, no Next.js imports — safe to use from client components,
 * API routes, the worker, and the iCal feed builder.
 */

import type { BusinessActivity, EntityType } from '@/lib/services/entity.service';
import { FARM_CAPABLE_ENTITY_TYPES } from '@/lib/book-templates';
import {
  ELECTION_FORM_LABELS,
  describeStatus,
  electionStatutoryDueDate,
  legacyEntityType,
  resolveTaxYear,
  sortHistory,
  statusSignature,
  type EntityStatusRow,
} from '@/lib/entity-status';

export type ComplianceSeverity = 'filing' | 'payment' | 'admin';

export interface ComplianceItem {
  /** Stable identifier for the deadline kind, e.g. 'fed-1040es'. */
  key: string;
  title: string;
  description: string;
  /** ISO YYYY-MM-DD. May fall in year+1 for Q4 payment schedules. */
  dueDate: string;
  /** '2026' for annual items, '2026-Q1'..'2026-Q4' for quarterlies. */
  period: string;
  /** In-app page that helps complete the item. */
  href?: string;
  severity: ComplianceSeverity;
}

export const COMPLIANCE_SEVERITY_LABELS: Record<ComplianceSeverity, string> = {
  filing: 'Filing',
  payment: 'Payment',
  admin: 'Admin',
};

export const ENTITY_RULESET_LABELS: Record<EntityType, string> = {
  household: 'Household (Form 1040)',
  sole_prop: 'Sole proprietorship (Schedule C)',
  llc_single: 'Single-member LLC (Schedule C)',
  llc_partnership: 'Partnership LLC (Form 1065)',
  s_corp: 'S-Corporation (Form 1120-S)',
  c_corp: 'C-Corporation (Form 1120)',
  nonprofit_501c3: '501(c)(3) nonprofit (Form 990)',
};

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function nthWeekdayOfMonth(year: number, month0: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month0, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return toIso(new Date(Date.UTC(year, month0, 1 + offset + (n - 1) * 7)));
}

function lastWeekdayOfMonth(year: number, month0: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return toIso(new Date(last.getTime() - offset * DAY_MS));
}

/** Fixed-date federal holiday with Sat→Friday / Sun→Monday observance. */
function observedFixed(year: number, month0: number, day: number): string {
  const d = new Date(Date.UTC(year, month0, day));
  const dow = d.getUTCDay();
  if (dow === 6) return toIso(new Date(d.getTime() - DAY_MS));
  if (dow === 0) return toIso(new Date(d.getTime() + DAY_MS));
  return toIso(d);
}

/**
 * Legal holidays for IRC §7503 purposes (federal holidays observed in DC,
 * including DC Emancipation Day — the one that famously moves April 15).
 * Cached per year.
 */
const holidayCache = new Map<number, Set<string>>();

function legalHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const set = new Set<string>([
    observedFixed(year, 0, 1), // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3), // MLK Day — 3rd Monday of January
    nthWeekdayOfMonth(year, 1, 1, 3), // Washington's Birthday — 3rd Monday of February
    observedFixed(year, 3, 16), // DC Emancipation Day
    lastWeekdayOfMonth(year, 4, 1), // Memorial Day — last Monday of May
    observedFixed(year, 5, 19), // Juneteenth
    observedFixed(year, 6, 4), // Independence Day
    nthWeekdayOfMonth(year, 8, 1, 1), // Labor Day — 1st Monday of September
    nthWeekdayOfMonth(year, 9, 1, 2), // Columbus Day — 2nd Monday of October
    observedFixed(year, 10, 11), // Veterans Day
    nthWeekdayOfMonth(year, 10, 4, 4), // Thanksgiving — 4th Thursday of November
    observedFixed(year, 11, 25), // Christmas
  ]);
  holidayCache.set(year, set);
  return set;
}

/**
 * IRC §7503: a deadline falling on a Saturday, Sunday, or legal holiday is
 * timely if performed on the next business day. Returns the ADJUSTED date
 * (the statutory date rolled forward past weekends/holidays) and a note
 * explaining the shift when one occurred.
 */
export function adjustDueDate(iso: string): { dueDate: string; note: string | null } {
  const [y, m, d] = iso.split('-').map(Number);
  let date = new Date(Date.UTC(y, m - 1, d));
  let moved = false;
  for (let i = 0; i < 10; i++) {
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6 && !legalHolidays(date.getUTCFullYear()).has(toIso(date))) {
      break;
    }
    date = new Date(date.getTime() + DAY_MS);
    moved = true;
  }
  if (!moved) return { dueDate: iso, note: null };
  return {
    dueDate: toIso(date),
    note: `The statutory date (${iso}) falls on a weekend or legal holiday, so the deadline moves to the next business day, ${toIso(date)}.`,
  };
}

function item(
  key: string,
  title: string,
  description: string,
  dueDate: string,
  period: string,
  severity: ComplianceSeverity,
  href?: string,
): ComplianceItem {
  const adjusted = adjustDueDate(dueDate);
  return {
    key,
    title,
    description: adjusted.note ? `${description} ${adjusted.note}` : description,
    dueDate: adjusted.dueDate,
    period,
    severity,
    ...(href ? { href } : {}),
  };
}

function isNorthCarolina(taxState: string | null | undefined): boolean {
  return (taxState ?? '').trim().toUpperCase() === 'NC';
}

/* ------------------------------------------------------------------ */
/* Shared item builders                                                */
/* ------------------------------------------------------------------ */

/** Federal 1040-ES quarterly estimated payments for tax year `year`. */
function estimatedTaxQuarterlies(year: number): ComplianceItem[] {
  const schedule: Array<{ q: 1 | 2 | 3 | 4; due: string; covers: string }> = [
    { q: 1, due: `${year}-04-15`, covers: 'January – March' },
    { q: 2, due: `${year}-06-15`, covers: 'April – May' },
    { q: 3, due: `${year}-09-15`, covers: 'June – August' },
    { q: 4, due: `${year + 1}-01-15`, covers: 'September – December' },
  ];
  return schedule.map(({ q, due, covers }) =>
    item(
      'fed-1040es',
      `1040-ES estimated tax payment — Q${q} ${year}`,
      `Federal estimated tax installment ${q} of 4 for tax year ${year} (income earned ${covers}).`,
      due,
      `${year}-Q${q}`,
      'payment',
      '/taxes/estimated',
    ),
  );
}

/** Form 941 quarterly payroll tax returns for tax year `year`. */
function form941Quarterlies(year: number): ComplianceItem[] {
  const schedule: Array<{ q: 1 | 2 | 3 | 4; due: string }> = [
    { q: 1, due: `${year}-04-30` },
    { q: 2, due: `${year}-07-31` },
    { q: 3, due: `${year}-10-31` },
    { q: 4, due: `${year + 1}-01-31` },
  ];
  return schedule.map(({ q, due }) =>
    item(
      'fed-941',
      `Form 941 payroll tax return — Q${q} ${year}`,
      `Quarterly federal return of income tax withheld plus employer/employee Social Security and Medicare for Q${q} ${year}.`,
      due,
      `${year}-Q${q}`,
      'payment',
    ),
  );
}

/** Federal 1040 filing (due in `year`, covering tax year `year - 1`). */
function federal1040Filing(year: number): ComplianceItem {
  return item(
    'fed-1040',
    'Federal income tax return (Form 1040)',
    `File your ${year - 1} federal return or request an automatic extension (Form 4868). An extension moves the filing deadline to October 15, ${year}, but any tax owed is still due April 15.`,
    `${year}-04-15`,
    `${year}`,
    'filing',
    '/tools/tax-estimator',
  );
}

/** 1099-NEC to contractors (due in `year`, covering payments made in `year - 1`). */
function form1099Nec(year: number, conditional = false): ComplianceItem {
  return item(
    'fed-1099-nec',
    'Form 1099-NEC to contractors',
    `${conditional ? 'If the organization paid contractors during ' : 'Furnish Form 1099-NEC to contractors paid during '}${year - 1}${conditional ? ', furnish Form 1099-NEC' : ''} — copies go to each contractor and to the IRS by January 31.`,
    `${year}-01-31`,
    `${year}`,
    'filing',
    '/business/reports/1099',
  );
}

/** W-2 to employees / W-3 to SSA (due in `year` for `year - 1` wages). */
function formW2W3(year: number): ComplianceItem {
  return item(
    'fed-w2-w3',
    'Forms W-2 / W-3',
    `Furnish ${year - 1} W-2s to employees and file W-2 copies with Form W-3 to the Social Security Administration by January 31.`,
    `${year}-01-31`,
    `${year}`,
    'filing',
  );
}

const NC_LLC_ANNUAL_REPORT_FEE = 'LLC annual reports carry a $200 fee ($203 filed online).';

/** NC Secretary of State annual report (LLCs and corporations). */
function ncAnnualReport(year: number, feeNote: string): ComplianceItem {
  return item(
    'nc-annual-report',
    'NC annual report (Secretary of State)',
    `File the North Carolina annual report for ${year}. ${feeNote}`,
    `${year}-04-15`,
    `${year}`,
    'admin',
  );
}

/** NC individual return (D-400), owner files alongside the 1040. */
function ncD400(year: number): ComplianceItem {
  return item(
    'nc-d400',
    'NC individual income tax return (D-400)',
    `File your ${year - 1} North Carolina individual return (or extension) by April 15.`,
    `${year}-04-15`,
    `${year}`,
    'filing',
  );
}

/**
 * Farm (Schedule F) items for pass-through entities. Farmers with ≥2/3 of
 * gross income from farming get special estimated-tax treatment: either a
 * single Jan 15 estimated payment, or no estimates at all when the return is
 * filed and paid by March 1.
 */
function farmItems(year: number, nc: boolean): ComplianceItem[] {
  const items: ComplianceItem[] = [
    item(
      'fed-farmer-jan15',
      'Farmer estimated tax — single Jan 15 payment option',
      `Farmers with at least two-thirds of ${year} gross income from farming may make ONE estimated payment for the whole year by January 15, ${year + 1}, instead of four quarterly 1040-ES installments.`,
      `${year + 1}-01-15`,
      `${year}`,
      'payment',
      '/taxes/estimated',
    ),
    item(
      'fed-farmer-mar1',
      'Farmer file-and-pay by March 1 (skip estimates)',
      `Farmers with at least two-thirds of ${year - 1} gross income from farming owe NO estimated payments at all if the ${year - 1} return (Form 1040 with Schedule F) is filed and the full tax paid by March 1, ${year}.`,
      `${year}-03-01`,
      `${year}`,
      'filing',
      '/business/reports/schedule-f',
    ),
  ];
  if (nc) {
    items.push(
      item(
        'nc-puv-listing',
        'NC present-use value listing period',
        `County listing period (typically all of January) — apply for or update present-use value classification on qualifying agricultural land (10+ acres in production, $1,000 average gross income; honey sales count since July 2023).`,
        `${year}-01-31`,
        `${year}`,
        'admin',
      ),
      item(
        'nc-e595qf',
        'NC qualifying farmer exemption certificate (E-595QF)',
        `Keep the qualifying-farmer sales-tax exemption current: the certificate requires $10,000+ gross farming income in the prior year (or 3-year average) evidenced on tax returns, and lapses after 3 consecutive years below the threshold. Conditional certificate holders (E-595CF) must submit copies of state and federal returns to NCDOR within 90 days of each filing.`,
        `${year}-04-15`,
        `${year}`,
        'admin',
        '/tools/farm-analyzer',
      ),
    );
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Per-entity rule sets                                                */
/* ------------------------------------------------------------------ */

function householdItems(year: number, nc: boolean): ComplianceItem[] {
  const items = [...estimatedTaxQuarterlies(year), federal1040Filing(year)];
  if (nc) items.push(ncD400(year));
  return items;
}

/**
 * All compliance deadlines an entity acts on for calendar year `year`.
 * Quarterly payment schedules (1040-ES, 941) belong to tax year `year`, so
 * their Q4 due dates fall in January of `year + 1`.
 *
 * `businessActivity` (optional, default 'general') adds farm/Schedule F
 * items — farmer estimated-tax options plus NC PUV/E-595QF admin items —
 * for pass-through entities labeled as farms.
 */
export function complianceItemsForYear(
  entityType: EntityType,
  taxState: string | null | undefined,
  year: number,
  businessActivity: BusinessActivity = 'general',
): ComplianceItem[] {
  const nc = isNorthCarolina(taxState);
  const items: ComplianceItem[] = [];

  switch (entityType) {
    case 'household':
      items.push(...householdItems(year, nc));
      break;

    case 'sole_prop':
      // The owner files everything on their 1040 (Schedule C).
      items.push(...householdItems(year, nc), form1099Nec(year));
      break;

    case 'llc_single':
      // Disregarded entity: owner's 1040 plus the LLC's state registration.
      items.push(...householdItems(year, nc), form1099Nec(year));
      if (nc) {
        items.push(
          ncAnnualReport(year, NC_LLC_ANNUAL_REPORT_FEE),
        );
      }
      break;

    case 'llc_partnership':
      items.push(
        item(
          'fed-1065',
          'Partnership return (Form 1065)',
          `File the ${year - 1} partnership return by March 15 or request an extension (Form 7004), which moves the deadline to September 15, ${year}.`,
          `${year}-03-15`,
          `${year}`,
          'filing',
        ),
        item(
          'fed-k1',
          'Schedule K-1s to partners',
          `Furnish each partner their ${year - 1} Schedule K-1 by the Form 1065 due date so they can file their personal returns.`,
          `${year}-03-15`,
          `${year}`,
          'filing',
        ),
        form1099Nec(year),
      );
      if (nc) {
        items.push(
          ncAnnualReport(year, NC_LLC_ANNUAL_REPORT_FEE),
        );
      }
      break;

    case 's_corp':
      items.push(
        item(
          'fed-1120s',
          'S-corporation return (Form 1120-S)',
          `File the ${year - 1} S-corp return by March 15 or request an extension (Form 7004), which moves the deadline to September 15, ${year}. Furnish K-1s to shareholders by the same date.`,
          `${year}-03-15`,
          `${year}`,
          'filing',
        ),
        formW2W3(year),
        ...form941Quarterlies(year),
        form1099Nec(year),
      );
      if (nc) {
        items.push(
          ncAnnualReport(year, 'Business corporation annual reports carry a $25 fee ($23 filed online).'),
          item(
            'nc-franchise-tax',
            'NC franchise tax (with CD-401S)',
            `North Carolina franchise tax is reported and paid with the ${year - 1} state S-corp return (CD-401S), due April 15 ($200 minimum for the first $1M of tax base).`,
            `${year}-04-15`,
            `${year}`,
            'payment',
          ),
        );
      }
      break;

    case 'c_corp':
      items.push(
        item(
          'fed-1120',
          'C-corporation return (Form 1120)',
          `File the ${year - 1} corporate return by April 15 or request an extension (Form 7004), which moves the deadline to October 15, ${year}. Tax owed is still due April 15.`,
          `${year}-04-15`,
          `${year}`,
          'filing',
        ),
        formW2W3(year),
        ...form941Quarterlies(year),
        form1099Nec(year),
      );
      if (nc) {
        items.push(
          ncAnnualReport(year, 'Business corporation annual reports carry a $25 fee ($23 filed online).'),
          item(
            'nc-franchise-tax',
            'NC franchise tax (with CD-405)',
            `North Carolina franchise tax is reported and paid with the ${year - 1} state corporate return (CD-405), due April 15.`,
            `${year}-04-15`,
            `${year}`,
            'payment',
          ),
        );
      }
      break;

    case 'nonprofit_501c3':
      items.push(
        item(
          'fed-990',
          'Form 990-N / 990-EZ (e-Postcard)',
          `Annual information return for fiscal year ${year - 1} — due the 15th day of the 5th month after fiscal year end (May 15 for calendar-year filers). Organizations with gross receipts of $50,000 or less can file the 990-N e-Postcard.`,
          `${year}-05-15`,
          `${year}`,
          'filing',
          '/business/reports/990',
        ),
        form1099Nec(year, true),
      );
      break;
  }

  if (businessActivity === 'farm' && FARM_CAPABLE_ENTITY_TYPES.has(entityType)) {
    items.push(...farmItems(year, nc));
  }

  return items;
}

/* ------------------------------------------------------------------ */
/* Effective-dated entity status                                       */
/* ------------------------------------------------------------------ */

/**
 * Items whose `period` names the calendar year they are DUE in but which
 * report on the PRIOR tax year (annual returns and information returns).
 * Everything else covers the tax year it is generated for: quarterly
 * payments, state annual reports, and farm admin items.
 */
export const ITEMS_COVERING_PRIOR_TAX_YEAR: ReadonlySet<string> = new Set([
  'fed-1040',
  'nc-d400',
  'fed-1099-nec',
  'fed-w2-w3',
  'fed-1065',
  'fed-k1',
  'fed-1120s',
  'fed-1120',
  'nc-franchise-tax',
  'fed-990',
  'fed-farmer-mar1',
]);

/** The tax year a generated item reports on. */
export function itemTaxYear(item: Pick<ComplianceItem, 'key' | 'period'>): number {
  const year = Number(item.period.slice(0, 4));
  return ITEMS_COVERING_PRIOR_TAX_YEAR.has(item.key) ? year - 1 : year;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return toIso(new Date(Date.UTC(y, m - 1, d + days)));
}

/** IRS processing window we allow before nudging about a missing acceptance letter. */
const ELECTION_ACCEPTANCE_FOLLOWUP_DAYS = 60;

/**
 * Items generated from the status history itself: election filing deadlines,
 * the IRS-acceptance follow-up, S-corp payroll setup, and short tax years.
 * Returned for every year; callers filter by due date. Each item's `period`
 * is the status row's effective date, which is unique per book.
 */
export function entityStatusItems(rows: readonly EntityStatusRow[]): ComplianceItem[] {
  const items: ComplianceItem[] = [];
  const sorted = sortHistory(rows);
  sorted.forEach((row, i) => {
    const previous = i > 0 ? sorted[i - 1] : null;
    const period = row.effectiveFrom;
    const statusText = describeStatus(row);

    if (row.electionForm && !row.electionFiledOn) {
      const statutory = electionStatutoryDueDate(row.electionForm, row.effectiveFrom);
      if (statutory) {
        items.push(
          item(
            `fed-election-${row.electionForm}`,
            `File ${ELECTION_FORM_LABELS[row.electionForm]} — effective ${row.effectiveFrom}`,
            row.electionForm === '2553'
              ? `To be taxed as an S-corporation from ${row.effectiveFrom}, Form 2553 must be filed no more than 2 months and 15 days after the start of that tax year. A late election normally takes effect the following year unless late-election relief applies. Record the filed date in Settings once it is sent.`
              : `A Form 8832 classification election can take effect no more than 75 days before it is filed, so for an effective date of ${row.effectiveFrom} it must be filed by this date. Record the filed date in Settings once it is sent.`,
            statutory,
            period,
            'filing',
            '/settings#entity-status',
          ),
        );
      }
    }

    if (row.electionForm && row.electionFiledOn && !row.electionAcceptedOn) {
      items.push(
        item(
          'fed-election-acceptance',
          `Record the IRS acceptance of ${ELECTION_FORM_LABELS[row.electionForm]}`,
          `The election was filed on ${row.electionFiledOn}. The IRS usually confirms it by letter (CP261 for an S election) within about 60 days. Record the acceptance date and attach the letter in Settings; if nothing has arrived, call the IRS Business & Specialty Tax Line.`,
          addDaysIso(row.electionFiledOn, ELECTION_ACCEPTANCE_FOLLOWUP_DAYS),
          period,
          'admin',
          '/settings#entity-status',
        ),
      );
    }

    const becomesSCorp =
      previous !== null &&
      row.taxClassification === 's_corp' &&
      previous.taxClassification !== 's_corp';
    if (becomesSCorp) {
      items.push(
        item(
          'entity-scorp-payroll-setup',
          `S-corporation status starts ${row.effectiveFrom}: set up payroll`,
          `From ${row.effectiveFrom} the business is ${statusText}. Owner-employees who work in the business must be paid a reasonable salary through payroll (W-2 wages with withholding and Form 941 deposits) before taking distributions. Set up payroll and decide the salary before this date.`,
          row.effectiveFrom,
          period,
          'admin',
          '/tools/s-corp-analyzer',
        ),
      );
    }

    if (
      previous !== null &&
      !row.effectiveFrom.endsWith('-01-01') &&
      statusSignature(previous) !== statusSignature(row)
    ) {
      const year = Number(row.effectiveFrom.slice(0, 4));
      items.push(
        item(
          'entity-short-tax-year',
          `Short tax years in ${year}: status changes on ${row.effectiveFrom}`,
          `The entity changes from ${describeStatus(previous)} to ${statusText} mid-year, which splits ${year} into short tax years that may each need their own return. This app applies the year-end status to the annual items for ${year}; confirm the filings with your tax preparer.`,
          row.effectiveFrom,
          period,
          'admin',
          '/settings#entity-status',
        ),
      );
    }
  });
  return items;
}

/**
 * All compliance deadlines a book acts on in calendar year `year`, resolved
 * against its effective-dated status history:
 *
 *   - items that report on the prior tax year (annual returns, W-2s, 1099s)
 *     follow the status in effect for tax year `year - 1`;
 *   - items for tax year `year` (quarterlies, annual reports) follow the
 *     status for `year`;
 *   - election / payroll-setup / short-year items come from the history and
 *     are included when they fall due in `year`.
 *
 * A mid-year change resolves each tax year to its year-end status (see
 * resolveTaxYear) and adds an 'entity-short-tax-year' item.
 */
export function complianceItemsForHistory(
  rows: readonly EntityStatusRow[],
  taxState: string | null | undefined,
  year: number,
  businessActivity: BusinessActivity = 'general',
): ComplianceItem[] {
  const typeFor = (taxYear: number): EntityType => {
    const status = resolveTaxYear(rows, taxYear).status;
    return status ? legacyEntityType(status.legalForm, status.taxClassification) : 'household';
  };
  const yearLegalForm = resolveTaxYear(rows, year).status?.legalForm ?? null;
  const current = complianceItemsForYear(typeFor(year), taxState, year, businessActivity)
    .filter((i) => !ITEMS_COVERING_PRIOR_TAX_YEAR.has(i.key))
    // The NC annual-report fee follows the LEGAL form: an LLC taxed as an
    // S- or C-corp still files the LLC report ($200), not the corporation's.
    .map((i) =>
      i.key === 'nc-annual-report' &&
      (yearLegalForm === 'llc_single_member' || yearLegalForm === 'llc_multi_member')
        ? ncAnnualReport(year, NC_LLC_ANNUAL_REPORT_FEE)
        : i,
    );
  const prior = complianceItemsForYear(typeFor(year - 1), taxState, year, businessActivity).filter(
    (i) => ITEMS_COVERING_PRIOR_TAX_YEAR.has(i.key),
  );
  const fromHistory = entityStatusItems(rows).filter((i) => i.dueDate.startsWith(`${year}-`));
  return [...prior, ...current, ...fromHistory];
}

/* ------------------------------------------------------------------ */
/* Status helpers                                                      */
/* ------------------------------------------------------------------ */

export type ComplianceStatus = 'pending' | 'done' | 'dismissed';

export interface ComplianceItemWithStatus extends ComplianceItem {
  status: ComplianceStatus;
  /** ISO timestamp when the item was marked done/dismissed (null if pending). */
  completedAt: string | null;
}

/** Composite lookup key used when merging persisted statuses onto items. */
export function complianceStatusKey(itemKey: string, period: string): string {
  return `${itemKey}|${period}`;
}
