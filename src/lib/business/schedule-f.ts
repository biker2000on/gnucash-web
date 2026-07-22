/**
 * Schedule F (Profit or Loss From Farming) estimate — pure functions.
 *
 * Mirrors the Schedule C builder (business-reports.ts) with farm-specific
 * lines: income is classified onto Part I lines (raised products, ag program
 * payments, custom hire, other) and expenses onto Part II lines 10–32 via
 * keyword rules with manual per-account overrides. Keyword vocabulary is
 * apiary-aware (feed/syrup, mite treatments, jars, bee purchases) but covers
 * general farm terms too.
 *
 * ESTIMATES ONLY — not filing software, not tax advice.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

interface ScheduleFRule {
    line: string;
    pattern: RegExp;
}

/**
 * Expense keyword rules — order matters (more specific first). Matched
 * against the leaf account name first, then the full path, so children
 * inherit a parent category.
 */
export const SCHEDULE_F_EXPENSE_RULES: ReadonlyArray<ScheduleFRule> = [
    { line: '16', pattern: /feed|syrup|pollen sub/i },
    { line: '31', pattern: /medic|mite|treatment|apivar|oxalic|formic|antibiotic|\bvet\b|veterinar|breeding/i },
    { line: '11', pattern: /chemical|pesticide|herbicide|insecticide|fungicide/i },
    { line: '17', pattern: /fertilizer|\blime\b/i },
    { line: '26', pattern: /\bseed\b|seeds|seedling|\bplants?\b/i },
    { line: '13', pattern: /custom hire|machine work/i },
    { line: '18', pattern: /freight|trucking|shipping/i },
    { line: '19', pattern: /gasoline|\bfuel\b|diesel|propane|\boil\b/i },
    // Vehicle after fuel so "Gasoline & Fuel" lands on 19, not 10.
    { line: '10', pattern: /\bcar\b|truck|vehicle|mileage|\bauto\b|parking|toll/i },
    { line: '20', pattern: /insurance/i },
    { line: '21b', pattern: /interest/i },
    { line: '22', pattern: /\blabor\b|wage|salar|payroll/i },
    { line: '24a', pattern: /equipment (rent|lease)|machinery (rent|lease)/i },
    { line: '24b', pattern: /\brent\b|rental|\blease\b/i },
    { line: '25', pattern: /repair|maintenance/i },
    { line: '27', pattern: /storage|warehous/i },
    { line: '14', pattern: /depreciation|section 179|§179/i },
    // (?!i) keeps "Taxi" out of taxes-and-licenses (same guard as Schedule C).
    { line: '29', pattern: /tax(?!i)|licen[cs]e|permit/i },
    { line: '30', pattern: /utilit|electric|water|sewer|internet|phone|telephone/i },
    { line: '28', pattern: /supplie|supply|jar|bottle|packaging|label|material|small tool/i },
    // Bee/queen/nuc purchases: deductible cost of non-resale production stock.
    { line: '32', pattern: /\bbees?\b|queen|\bnucs?\b|package/i },
];

/** Income keyword rules; unmatched income defaults to line 2 (raised products). */
export const SCHEDULE_F_INCOME_RULES: ReadonlyArray<ScheduleFRule> = [
    { line: '4a', pattern: /ag(ricultural)? program|program payment|subsid|cfap|\busda\b/i },
    { line: '7', pattern: /custom hire|machine work/i },
    { line: '8', pattern: /pollination|other (farm )?income|rebate|refund|patronage/i },
    { line: '1a', pattern: /resale/i },
];

export const SCHEDULE_F_LINE_LABELS: Record<string, string> = {
    '1a': 'Sales of purchased livestock/items bought for resale',
    '2': 'Sales of products you raised (honey, wax, bees)',
    '4a': 'Agricultural program payments',
    '7': 'Custom hire (machine work) income',
    '8': 'Other farm income',
    '10': 'Car and truck expenses',
    '11': 'Chemicals',
    '13': 'Custom hire (machine work)',
    '14': 'Depreciation and Section 179',
    '15': 'Employee benefit programs',
    '16': 'Feed',
    '17': 'Fertilizers and lime',
    '18': 'Freight and trucking',
    '19': 'Gasoline, fuel, and oil',
    '20': 'Insurance (other than health)',
    '21b': 'Interest',
    '22': 'Labor hired',
    '24a': 'Rent/lease: vehicles, machinery, equipment',
    '24b': 'Rent/lease: other (land, animals)',
    '25': 'Repairs and maintenance',
    '26': 'Seeds and plants',
    '27': 'Storage and warehousing',
    '28': 'Supplies',
    '29': 'Taxes',
    '30': 'Utilities',
    '31': 'Veterinary, breeding, and medicine',
    '32': 'Other expenses',
};

/** Display order for Part I income lines. */
export const SCHEDULE_F_INCOME_LINE_ORDER = ['1a', '2', '4a', '7', '8'] as const;

/** Display order for Part II expense lines. */
export const SCHEDULE_F_EXPENSE_LINE_ORDER = [
    '10', '11', '13', '14', '15', '16', '17', '18', '19', '20', '21b',
    '22', '24a', '24b', '25', '26', '27', '28', '29', '30', '31', '32',
] as const;

/** Expense lines a MANUAL override may target. */
export const SCHEDULE_F_MANUAL_LINES: ReadonlySet<string> = new Set(
    SCHEDULE_F_EXPENSE_LINE_ORDER,
);

/** True when `line` is a valid manual-override Schedule F expense line. */
export function isValidScheduleFLine(line: unknown): line is string {
    return typeof line === 'string' && SCHEDULE_F_MANUAL_LINES.has(line);
}

function matchRules(
    rules: ReadonlyArray<ScheduleFRule>,
    name: string,
    path: string,
): string | null {
    for (const rule of rules) {
        if (rule.pattern.test(name)) return rule.line;
    }
    for (const rule of rules) {
        if (rule.pattern.test(path)) return rule.line;
    }
    return null;
}

/** Map an expense account to a Schedule F line (null when unmapped → 32). */
export function mapFarmExpenseAccountToLine(name: string, path: string): string | null {
    return matchRules(SCHEDULE_F_EXPENSE_RULES, name, path);
}

/** Map an income account to a Schedule F Part I line (null → line 2). */
export function mapFarmIncomeAccountToLine(name: string, path: string): string | null {
    return matchRules(SCHEDULE_F_INCOME_RULES, name, path);
}

export interface ScheduleFAccountInput {
    guid: string;
    name: string;
    /** Full account path, e.g. "Expenses:Farm:Feed & Syrup". */
    path: string;
    type: 'INCOME' | 'EXPENSE';
    /** Raw split-value sum for the year (income negative, expenses positive). */
    total: number;
}

export interface ScheduleFAccountDetail {
    guid: string;
    name: string;
    path: string;
    amount: number;
    /** Keyword-heuristic line (income default '2', expense default '32'). */
    suggestedLine: string | null;
    /** Effective line after applying manual overrides. */
    mappedLine: string;
}

export interface ScheduleFLine {
    line: string;
    label: string;
    amount: number;
    accounts: ScheduleFAccountDetail[];
}

export interface ScheduleFReport {
    year: number;
    /** Line 9 — gross farm income (sum of Part I). */
    grossIncome: number;
    /** Part I lines in SCHEDULE_F_INCOME_LINE_ORDER (zero lines included). */
    incomeLines: ScheduleFLine[];
    /** Part II lines in SCHEDULE_F_EXPENSE_LINE_ORDER (zero lines included). */
    expenseLines: ScheduleFLine[];
    /** Line 33 — total expenses. */
    totalExpenses: number;
    /** Line 34 — net farm profit or (loss). */
    netProfit: number;
    /** Expense accounts that fell through to line 32 with no keyword match. */
    unmappedCount: number;
    /** Expense accounts whose line came from a manual override. */
    overriddenCount: number;
}

/**
 * Build a Schedule F estimate from INCOME/EXPENSE totals for a tax year.
 * Pure. `overrides` maps expense account GUID → manual Schedule F line and
 * WINS over the keyword heuristic; invalid stored lines fall back to the
 * keyword result (then line 32).
 */
export function buildScheduleF(
    year: number,
    accounts: ReadonlyArray<ScheduleFAccountInput>,
    overrides: Record<string, string> = {},
): ScheduleFReport {
    const incomeMap = new Map<string, ScheduleFLine>();
    for (const line of SCHEDULE_F_INCOME_LINE_ORDER) {
        incomeMap.set(line, {
            line, label: SCHEDULE_F_LINE_LABELS[line], amount: 0, accounts: [],
        });
    }
    const expenseMap = new Map<string, ScheduleFLine>();
    for (const line of SCHEDULE_F_EXPENSE_LINE_ORDER) {
        expenseMap.set(line, {
            line, label: SCHEDULE_F_LINE_LABELS[line], amount: 0, accounts: [],
        });
    }

    let unmappedCount = 0;
    let overriddenCount = 0;

    for (const acct of accounts) {
        if (Math.abs(acct.total) < 0.005) continue;

        if (acct.type === 'INCOME') {
            // GnuCash stores income as credits (negative) — negate for display.
            const amount = round2(-acct.total);
            const suggested = mapFarmIncomeAccountToLine(acct.name, acct.path);
            const lineNo = suggested ?? '2';
            const line = incomeMap.get(lineNo)!;
            line.amount = round2(line.amount + amount);
            line.accounts.push({
                guid: acct.guid, name: acct.name, path: acct.path, amount,
                suggestedLine: suggested, mappedLine: lineNo,
            });
            continue;
        }

        const suggested = mapFarmExpenseAccountToLine(acct.name, acct.path);
        const override = overrides[acct.guid];
        const overridden = isValidScheduleFLine(override);
        const lineNo = overridden ? override : (suggested ?? '32');
        if (overridden) overriddenCount++;
        else if (!suggested) unmappedCount++;

        const line = expenseMap.get(lineNo)!;
        const amount = round2(acct.total);
        line.amount = round2(line.amount + amount);
        line.accounts.push({
            guid: acct.guid, name: acct.name, path: acct.path, amount,
            suggestedLine: suggested, mappedLine: lineNo,
        });
    }

    let grossIncome = 0;
    for (const line of incomeMap.values()) {
        grossIncome = round2(grossIncome + line.amount);
        line.accounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    }
    let totalExpenses = 0;
    for (const line of expenseMap.values()) {
        totalExpenses = round2(totalExpenses + line.amount);
        line.accounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    }

    return {
        year,
        grossIncome,
        incomeLines: SCHEDULE_F_INCOME_LINE_ORDER.map((l) => incomeMap.get(l)!),
        expenseLines: SCHEDULE_F_EXPENSE_LINE_ORDER.map((l) => expenseMap.get(l)!),
        totalExpenses,
        netProfit: round2(grossIncome - totalExpenses),
        unmappedCount,
        overriddenCount,
    };
}
