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

const WEEKEND_NOTE =
  'This date falls on a weekend, so the effective deadline is the next business day.';

/**
 * Append a weekend note when the ISO date is a Saturday or Sunday.
 * TODO: also shift for federal holidays (Emancipation Day famously moves
 * April 15) — for now the note only covers weekends and dates are not moved.
 */
function withWeekendNote(iso: string, description: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) {
    return `${description} ${WEEKEND_NOTE}`;
  }
  return description;
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
  return {
    key,
    title,
    description: withWeekendNote(dueDate, description),
    dueDate,
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
          ncAnnualReport(year, 'LLC annual reports carry a $200 fee ($203 filed online).'),
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
          ncAnnualReport(year, 'LLC annual reports carry a $200 fee ($203 filed online).'),
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
