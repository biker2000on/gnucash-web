/**
 * Demo Book Seed Plans (pure)
 *
 * Deterministic generators for the sample data seeded into demo books.
 * Given a `today` anchor date, each builder returns a complete plan —
 * accounts to ensure, ~12 months of transactions, commodity prices, and
 * tax-category mappings — with NO randomness: amounts come from fixed
 * tables, dates from fixed schedules relative to the anchor. Calling a
 * builder twice with the same date yields an identical plan.
 *
 * Applied by src/lib/services/demo-book.service.ts. This module is pure
 * (no prisma import) so tests can verify determinism and balance without
 * any database mocking.
 *
 * Conventions:
 * - All amounts are integer cents; every transaction's split values sum to 0.
 * - Account paths are colon-delimited relative to the book root and must
 *   match the entity account templates in src/lib/book-templates.ts (extra
 *   demo-only accounts are declared in plan.accounts and created on apply).
 * - GnuCash signs: income credits are negative, expense debits positive.
 */

export type DemoBookKind = 'household' | 'business';

export const DEMO_BOOK_DESCRIPTION = 'DEMO — sample data';

/** Marker prefix the UI uses to badge demo books. */
export const DEMO_DESCRIPTION_PREFIX = 'DEMO';

/** Stock commodity used by the household investment account. */
export const DEMO_STOCK = {
    namespace: 'DEMO',
    mnemonic: 'DMOFX',
    fullname: 'Demo Index Fund',
    fraction: 10000,
} as const;

export interface DemoAccountSpec {
    /** Colon-delimited path under the book root. */
    path: string;
    /** GnuCash account type (BANK, EXPENSE, STOCK, ...). */
    type: string;
    /** 'USD' (default) or 'DEMO' for the demo stock commodity. */
    commodity?: 'USD' | 'DEMO';
}

export interface DemoSplitSpec {
    accountPath: string;
    /** Split value in integer cents (transaction currency). */
    valueCents: number;
    /** Quantity numerator; defaults to valueCents (currency accounts). */
    quantityNum?: number;
    /** Quantity denominator; defaults to 100 (currency accounts). */
    quantityDenom?: number;
    memo?: string;
    action?: string;
}

export interface DemoTransactionSpec {
    /** ISO date YYYY-MM-DD. */
    date: string;
    description: string;
    num?: string;
    splits: DemoSplitSpec[];
}

export interface DemoPriceSpec {
    /** ISO date YYYY-MM-DD. */
    date: string;
    /** Price per share in integer cents. */
    priceCents: number;
}

export interface DemoTaxMappingSpec {
    accountPath: string;
    taxCategory: string;
}

export interface DemoSeedPlan {
    kind: DemoBookKind;
    /** Every account the transactions reference (existing ones are reused). */
    accounts: DemoAccountSpec[];
    transactions: DemoTransactionSpec[];
    /** Prices for the DEMO stock commodity (household only). */
    prices: DemoPriceSpec[];
    taxMappings: DemoTaxMappingSpec[];
}

// ---------------------------------------------------------------------------
// Date helpers (all UTC to avoid timezone drift)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function toUtcMidnight(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
    return new Date(d.getTime() + n * DAY_MS);
}

function iso(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/** The `day`-th of the month `monthsBack` months before the anchor. */
function monthDay(anchor: Date, monthsBack: number, day: number): Date {
    return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - monthsBack, day));
}

// ---------------------------------------------------------------------------
// Household plan
// ---------------------------------------------------------------------------

const HH = {
    checking: 'Assets:Current Assets:Checking Account',
    savings: 'Assets:Current Assets:Savings Account',
    brokerage: 'Assets:Investments:Brokerage Account',
    demoFund: 'Assets:Investments:Brokerage Account:Demo Index Fund',
    k401: 'Assets:Investments:401(k)',
    salary: 'Income:Salary',
    rent: 'Expenses:Rent/Mortgage',
    groceries: 'Expenses:Groceries',
    utilities: 'Expenses:Utilities',
    dining: 'Expenses:Dining Out',
    subscriptions: 'Expenses:Subscriptions',
    fedTax: 'Expenses:Taxes:Federal Tax',
    stateTax: 'Expenses:Taxes:State Tax',
    socialSecurity: 'Expenses:Taxes:Social Security',
    medicare: 'Expenses:Taxes:Medicare',
    opening: 'Equity:Opening Balances',
} as const;

/** Grocery amounts in cents, cycled in date order (two trips a week). */
const GROCERY_AMOUNTS = [8245, 5610, 9723, 6480, 7215, 8890, 4530, 10240, 6875, 7940];
const GROCERY_STORES = ['Harvest Market', 'FreshCo'];

/** Friday dinner amounts in cents, cycled. */
const DINING_AMOUNTS = [4680, 3250, 7215, 5540, 2895, 6120];
const DINING_PLACES = ['Thai Basil', 'La Cocina', 'Blue Finch Diner', 'Sakura Sushi'];

/** Utility bill by calendar month (Jan..Dec), cents — seasonal shape. */
const UTILITY_BY_MONTH = [21000, 19500, 16000, 13000, 11000, 12500, 14500, 15000, 12000, 11500, 15500, 19000];

/** Paycheck anatomy, cents. Gross = sum of the withholdings + net. */
const PAYCHECK = {
    gross: 400000,
    federal: 62000,
    state: 18500,
    socialSecurity: 24800,
    medicare: 5800,
    k401: 40000,
    net: 400000 - 62000 - 18500 - 24800 - 5800 - 40000, // 248900
} as const;

/** Monthly demo-fund buy, cents; price appreciates a fixed step per month. */
const INVEST_BUY_CENTS = 50000;
const DEMO_FUND_START_PRICE_CENTS = 4000;
const DEMO_FUND_PRICE_STEP_CENTS = 75;

function buildHouseholdPlan(anchor: Date): DemoSeedPlan {
    const transactions: DemoTransactionSpec[] = [];
    const prices: DemoPriceSpec[] = [];

    // Opening balances one year back so running balances start realistic.
    transactions.push({
        date: iso(addDays(anchor, -365)),
        description: 'Opening balance',
        splits: [
            { accountPath: HH.checking, valueCents: 320000 },
            { accountPath: HH.savings, valueCents: 1200000 },
            { accountPath: HH.opening, valueCents: -1520000 },
        ],
    });

    // Biweekly paychecks: the 26 paydays ending on the most recent Friday.
    const fridayOffset = (anchor.getUTCDay() - 5 + 7) % 7;
    const lastFriday = addDays(anchor, -fridayOffset);
    for (let i = 25; i >= 0; i--) {
        const payday = addDays(lastFriday, -14 * i);
        transactions.push({
            date: iso(payday),
            description: 'Paycheck — Acme Corp',
            splits: [
                { accountPath: HH.salary, valueCents: -PAYCHECK.gross, memo: 'Gross pay' },
                { accountPath: HH.fedTax, valueCents: PAYCHECK.federal, memo: 'Federal withholding' },
                { accountPath: HH.stateTax, valueCents: PAYCHECK.state, memo: 'State withholding' },
                { accountPath: HH.socialSecurity, valueCents: PAYCHECK.socialSecurity },
                { accountPath: HH.medicare, valueCents: PAYCHECK.medicare },
                { accountPath: HH.k401, valueCents: PAYCHECK.k401, memo: '401(k) employee contribution' },
                { accountPath: HH.checking, valueCents: PAYCHECK.net, memo: 'Net pay' },
            ],
        });
    }

    // Monthly items over the last 12 calendar months (skip future dates).
    for (let monthsBack = 11; monthsBack >= 0; monthsBack--) {
        const monthIndex = 11 - monthsBack; // 0 = oldest month

        const rentDate = monthDay(anchor, monthsBack, 1);
        if (rentDate <= anchor) {
            transactions.push({
                date: iso(rentDate),
                description: 'Rent — Maple Street Apartments',
                splits: [
                    { accountPath: HH.rent, valueCents: 185000 },
                    { accountPath: HH.checking, valueCents: -185000 },
                ],
            });
        }

        const netflixDate = monthDay(anchor, monthsBack, 3);
        if (netflixDate <= anchor) {
            transactions.push({
                date: iso(netflixDate),
                description: 'Netflix',
                splits: [
                    { accountPath: HH.subscriptions, valueCents: 1549 },
                    { accountPath: HH.checking, valueCents: -1549 },
                ],
            });
        }

        const savingsDate = monthDay(anchor, monthsBack, 5);
        if (savingsDate <= anchor) {
            transactions.push({
                date: iso(savingsDate),
                description: 'Transfer to savings — emergency fund',
                splits: [
                    { accountPath: HH.savings, valueCents: 30000 },
                    { accountPath: HH.checking, valueCents: -30000 },
                ],
            });
        }

        const spotifyDate = monthDay(anchor, monthsBack, 9);
        if (spotifyDate <= anchor) {
            transactions.push({
                date: iso(spotifyDate),
                description: 'Spotify',
                splits: [
                    { accountPath: HH.subscriptions, valueCents: 1199 },
                    { accountPath: HH.checking, valueCents: -1199 },
                ],
            });
        }

        const utilityDate = monthDay(anchor, monthsBack, 15);
        if (utilityDate <= anchor) {
            const amount = UTILITY_BY_MONTH[utilityDate.getUTCMonth()];
            transactions.push({
                date: iso(utilityDate),
                description: 'Electric & gas — City Utilities',
                splits: [
                    { accountPath: HH.utilities, valueCents: amount },
                    { accountPath: HH.checking, valueCents: -amount },
                ],
            });
        }

        const buyDate = monthDay(anchor, monthsBack, 20);
        if (buyDate <= anchor) {
            const priceCents = DEMO_FUND_START_PRICE_CENTS + DEMO_FUND_PRICE_STEP_CENTS * monthIndex;
            // Shares to 4 decimal places (fraction 10000).
            const quantityNum = Math.round((INVEST_BUY_CENTS / priceCents) * 10000);
            transactions.push({
                date: iso(buyDate),
                description: 'Buy DMOFX — monthly investment',
                splits: [
                    {
                        accountPath: HH.demoFund,
                        valueCents: INVEST_BUY_CENTS,
                        quantityNum,
                        quantityDenom: 10000,
                        action: 'Buy',
                    },
                    { accountPath: HH.checking, valueCents: -INVEST_BUY_CENTS },
                ],
            });
            prices.push({ date: iso(buyDate), priceCents });
        }
    }

    // Groceries (Wed + Sat) and dining out (Fri) over the trailing year.
    const weekly: DemoTransactionSpec[] = [];
    let groceryIdx = 0;
    let diningIdx = 0;
    for (let back = 364; back >= 0; back--) {
        const d = addDays(anchor, -back);
        const dow = d.getUTCDay();
        if (dow === 3 || dow === 6) {
            const amount = GROCERY_AMOUNTS[groceryIdx % GROCERY_AMOUNTS.length];
            const store = GROCERY_STORES[groceryIdx % GROCERY_STORES.length];
            groceryIdx++;
            weekly.push({
                date: iso(d),
                description: `Groceries — ${store}`,
                splits: [
                    { accountPath: HH.groceries, valueCents: amount },
                    { accountPath: HH.checking, valueCents: -amount },
                ],
            });
        }
        if (dow === 5) {
            const amount = DINING_AMOUNTS[diningIdx % DINING_AMOUNTS.length];
            const place = DINING_PLACES[diningIdx % DINING_PLACES.length];
            diningIdx++;
            weekly.push({
                date: iso(d),
                description: `Dinner out — ${place}`,
                splits: [
                    { accountPath: HH.dining, valueCents: amount },
                    { accountPath: HH.checking, valueCents: -amount },
                ],
            });
        }
    }
    transactions.push(...weekly);
    transactions.sort((a, b) => a.date.localeCompare(b.date));

    return {
        kind: 'household',
        accounts: [
            { path: HH.checking, type: 'BANK' },
            { path: HH.savings, type: 'BANK' },
            { path: HH.brokerage, type: 'ASSET' },
            { path: HH.demoFund, type: 'STOCK', commodity: 'DEMO' },
            { path: HH.k401, type: 'ASSET' },
            { path: HH.salary, type: 'INCOME' },
            { path: HH.rent, type: 'EXPENSE' },
            { path: HH.groceries, type: 'EXPENSE' },
            { path: HH.utilities, type: 'EXPENSE' },
            { path: HH.dining, type: 'EXPENSE' },
            { path: HH.subscriptions, type: 'EXPENSE' },
            { path: HH.fedTax, type: 'EXPENSE' },
            { path: HH.stateTax, type: 'EXPENSE' },
            { path: HH.socialSecurity, type: 'EXPENSE' },
            { path: HH.medicare, type: 'EXPENSE' },
            { path: HH.opening, type: 'EQUITY' },
        ],
        transactions,
        prices,
        taxMappings: [],
    };
}

// ---------------------------------------------------------------------------
// Business plan (single-member LLC)
// ---------------------------------------------------------------------------

const BIZ = {
    checking: 'Assets:Checking',
    receivable: 'Assets:Accounts Receivable',
    income: 'Income',
    serviceIncome: 'Income:Service Income',
    expenses: 'Expenses',
    software: 'Expenses:Software & Subscriptions',
    insurance: 'Expenses:Insurance',
    ownerDraw: "Equity:Owner's Draw",
    opening: 'Equity:Opening Balances',
} as const;

/** The three demo clients with fixed monthly retainers, cents. */
const CUSTOMERS = [
    { name: 'Acme Corp', amountCents: 350000 },
    { name: 'Bluebird Studios', amountCents: 210000 },
    { name: 'Cedar & Pine LLC', amountCents: 145000 },
] as const;

function buildBusinessPlan(anchor: Date): DemoSeedPlan {
    const transactions: DemoTransactionSpec[] = [];

    transactions.push({
        date: iso(addDays(anchor, -365)),
        description: 'Opening balance',
        splits: [
            { accountPath: BIZ.checking, valueCents: 1000000 },
            { accountPath: BIZ.opening, valueCents: -1000000 },
        ],
    });

    // Monthly client invoices (posted on the 5th) + payments 18 days later.
    // The most recent invoice for the first two customers stays unpaid so the
    // AR aging / open-invoice views have something to show.
    CUSTOMERS.forEach((customer, customerIdx) => {
        const invoiceDates: { date: Date; num: string }[] = [];
        for (let monthsBack = 11; monthsBack >= 0; monthsBack--) {
            const invoiceDate = monthDay(anchor, monthsBack, 5);
            if (invoiceDate > anchor) continue;
            const monthIndex = 11 - monthsBack;
            invoiceDates.push({ date: invoiceDate, num: `INV-${1001 + monthIndex * 3 + customerIdx}` });
        }
        invoiceDates.forEach(({ date, num }, i) => {
            transactions.push({
                date: iso(date),
                description: `Invoice ${num} — ${customer.name}`,
                num,
                splits: [
                    { accountPath: BIZ.receivable, valueCents: customer.amountCents, action: 'Invoice' },
                    { accountPath: BIZ.serviceIncome, valueCents: -customer.amountCents },
                ],
            });
            const isMostRecent = i === invoiceDates.length - 1;
            if (customerIdx <= 1 && isMostRecent) return; // leave unpaid
            const paymentDate = addDays(date, 18);
            if (paymentDate > anchor) return;
            transactions.push({
                date: iso(paymentDate),
                description: `Payment ${num} — ${customer.name}`,
                num,
                splits: [
                    { accountPath: BIZ.checking, valueCents: customer.amountCents, action: 'Payment' },
                    { accountPath: BIZ.receivable, valueCents: -customer.amountCents },
                ],
            });
        });
    });

    for (let monthsBack = 11; monthsBack >= 0; monthsBack--) {
        const softwareDate = monthDay(anchor, monthsBack, 8);
        if (softwareDate <= anchor) {
            transactions.push({
                date: iso(softwareDate),
                description: 'SaaS tools — dev & productivity',
                splits: [
                    { accountPath: BIZ.software, valueCents: 8900 },
                    { accountPath: BIZ.checking, valueCents: -8900 },
                ],
            });
        }

        const insuranceDate = monthDay(anchor, monthsBack, 12);
        if (insuranceDate <= anchor) {
            transactions.push({
                date: iso(insuranceDate),
                description: 'Business liability insurance',
                splits: [
                    { accountPath: BIZ.insurance, valueCents: 14500 },
                    { accountPath: BIZ.checking, valueCents: -14500 },
                ],
            });
        }

        // Quarterly owner draw on the 28th (oldest month, then every 3rd).
        const monthIndex = 11 - monthsBack;
        if (monthIndex % 3 === 0) {
            const drawDate = monthDay(anchor, monthsBack, 28);
            if (drawDate <= anchor) {
                transactions.push({
                    date: iso(drawDate),
                    description: 'Owner draw',
                    splits: [
                        { accountPath: BIZ.ownerDraw, valueCents: 400000 },
                        { accountPath: BIZ.checking, valueCents: -400000 },
                    ],
                });
            }
        }
    }

    transactions.sort((a, b) => a.date.localeCompare(b.date));

    return {
        kind: 'business',
        accounts: [
            { path: BIZ.checking, type: 'BANK' },
            { path: BIZ.receivable, type: 'RECEIVABLE' },
            { path: BIZ.serviceIncome, type: 'INCOME' },
            { path: BIZ.software, type: 'EXPENSE' },
            { path: BIZ.insurance, type: 'EXPENSE' },
            { path: BIZ.ownerDraw, type: 'EQUITY' },
            { path: BIZ.opening, type: 'EQUITY' },
        ],
        transactions,
        prices: [],
        taxMappings: [
            { accountPath: BIZ.income, taxCategory: 'self_employment_income' },
            { accountPath: BIZ.expenses, taxCategory: 'business_expense' },
        ],
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the deterministic seed plan for a demo book. `today` defaults to the
 * current date; pass a fixed date in tests for stable output.
 */
export function buildDemoSeedPlan(kind: DemoBookKind, today: Date = new Date()): DemoSeedPlan {
    const anchor = toUtcMidnight(today);
    return kind === 'household' ? buildHouseholdPlan(anchor) : buildBusinessPlan(anchor);
}
