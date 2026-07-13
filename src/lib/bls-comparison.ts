import prisma from '@/lib/prisma';

/**
 * BLS Spending Comparison
 *
 * Compares the book's annual spending by category against national averages
 * from the U.S. Bureau of Labor Statistics Consumer Expenditure Survey (CES).
 *
 * ── Dataset caveats (surface these in the UI) ────────────────────────────
 * The embedded dataset is an APPROXIMATE snapshot of CES 2023 annual mean
 * expenditures per consumer unit ("all consumer units" column), rounded and
 * reconstructed from published summary tables — it is NOT an official BLS
 * export and should be treated as directional only. Figures by household
 * size are derived from the all-units averages using coarse per-size
 * multipliers modeled on the CES "size of consumer unit" tables. National
 * averages ignore region, income, and age composition.
 *
 * ── Category mapping ─────────────────────────────────────────────────────
 * Book expense accounts are mapped to BLS categories with a keyword
 * heuristic over the full account path (mirroring the approach used by
 * contribution-classifier.ts). First matching rule wins; rules are ordered
 * from most to least specific. Unmapped spending is reported separately so
 * the comparison stays honest. v1 is heuristic-only (no per-account
 * overrides).
 */

// ---------------------------------------------------------------------------
// Static dataset
// ---------------------------------------------------------------------------

export const BLS_VINTAGE =
    'BLS Consumer Expenditure Survey 2023 (approximate, national averages)';

export type BlsCategoryId =
    | 'food_at_home'
    | 'food_away'
    | 'housing'
    | 'utilities'
    | 'transportation'
    | 'gasoline'
    | 'healthcare'
    | 'entertainment'
    | 'apparel'
    | 'education'
    | 'personal_care'
    | 'cash_contributions';

export interface BlsCategory {
    id: BlsCategoryId;
    label: string;
    /** Approximate CES 2023 annual mean, all consumer units, USD. */
    annualAllUnits: number;
}

/** Approximate CES 2023 annual means per consumer unit (USD). */
export const BLS_CATEGORIES: BlsCategory[] = [
    { id: 'food_at_home', label: 'Food at home', annualAllUnits: 5_700 },
    { id: 'food_away', label: 'Food away from home', annualAllUnits: 3_930 },
    { id: 'housing', label: 'Housing (shelter)', annualAllUnits: 15_060 },
    { id: 'utilities', label: 'Utilities & public services', annualAllUnits: 4_630 },
    { id: 'transportation', label: 'Transportation (ex. gasoline)', annualAllUnits: 10_730 },
    { id: 'gasoline', label: 'Gasoline & other fuels', annualAllUnits: 2_450 },
    { id: 'healthcare', label: 'Healthcare', annualAllUnits: 6_160 },
    { id: 'entertainment', label: 'Entertainment', annualAllUnits: 3_640 },
    { id: 'apparel', label: 'Apparel & services', annualAllUnits: 2_040 },
    { id: 'education', label: 'Education', annualAllUnits: 1_660 },
    { id: 'personal_care', label: 'Personal care', annualAllUnits: 950 },
    { id: 'cash_contributions', label: 'Cash contributions (charity)', annualAllUnits: 2_380 },
];

/**
 * Coarse spending multipliers by household size relative to the all-units
 * average, modeled on the CES "size of consumer unit" tables (approximate).
 * Size 5 means "5 or more".
 */
export const BLS_SIZE_MULTIPLIERS: Record<1 | 2 | 3 | 4 | 5, number> = {
    1: 0.62,
    2: 1.09,
    3: 1.21,
    4: 1.38,
    5: 1.36,
};

export type HouseholdSize = 1 | 2 | 3 | 4 | 5;

/** Clamp any number to a valid household size bucket (5 = "5+"). */
export function clampHouseholdSize(size: number): HouseholdSize {
    if (!Number.isFinite(size)) return 2;
    return Math.min(5, Math.max(1, Math.round(size))) as HouseholdSize;
}

/** Approximate BLS annual average for a category and household size. */
export function getBlsAverage(categoryId: BlsCategoryId, householdSize: number): number {
    const category = BLS_CATEGORIES.find((c) => c.id === categoryId);
    if (!category) return 0;
    const multiplier = BLS_SIZE_MULTIPLIERS[clampHouseholdSize(householdSize)];
    return Math.round(category.annualAllUnits * multiplier);
}

// ---------------------------------------------------------------------------
// Category mapping heuristic
// ---------------------------------------------------------------------------

interface MappingRule {
    category: BlsCategoryId;
    keywords: string[];
}

/**
 * Short/ambiguous keywords that must match a whole word (e.g. 'cell' must not
 * match "miscellaneous", 'car' must not match "cards"). All other keywords
 * match at a leading word boundary with any suffix ('movie' → "movies").
 */
const EXACT_WORD_KEYWORDS = new Set([
    'car', 'bus', 'hoa', 'cell', 'food', 'rent', 'fuel', 'home', 'auto', 'toll', 'cafe', 'game',
]);

function escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordRegex(keyword: string): RegExp {
    const suffix = EXACT_WORD_KEYWORDS.has(keyword) ? '\\b' : '';
    return new RegExp(`\\b${escapeRegex(keyword)}${suffix}`);
}

/**
 * Ordered first-match-wins keyword rules, most specific first. Keywords are
 * matched at word boundaries against the lowercased full account path.
 */
const MAPPING_RULES: MappingRule[] = [
    { category: 'gasoline', keywords: ['gasoline', 'gas station', 'petrol', 'fuel', 'fuels'] },
    {
        category: 'utilities',
        keywords: [
            'utilities', 'utility', 'electric', 'natural gas', 'water', 'sewer',
            'internet', 'phone', 'cell', 'cellphone', 'cellular', 'cable', 'trash',
            'garbage', 'heating oil',
        ],
    },
    {
        category: 'food_away',
        keywords: [
            'restaurant', 'dining', 'takeout', 'take-out', 'fast food', 'coffee',
            'cafe', 'doordash', 'ubereats', 'grubhub', 'eating out', 'food away',
        ],
    },
    {
        category: 'cash_contributions',
        keywords: ['charity', 'charitable', 'donation', 'tithe', 'church', 'giving'],
    },
    {
        category: 'personal_care',
        keywords: ['personal care', 'haircut', 'salon', 'barber', 'cosmetics', 'toiletries', 'grooming'],
    },
    {
        category: 'education',
        keywords: ['education', 'tuition', 'school', 'student loan', 'textbook', 'course'],
    },
    { category: 'apparel', keywords: ['clothing', 'clothes', 'apparel', 'shoes', 'wardrobe'] },
    {
        category: 'healthcare',
        keywords: [
            'health', 'medical', 'doctor', 'dentist', 'dental', 'pharmacy',
            'prescription', 'vision', 'therapy', 'hospital', 'copay',
        ],
    },
    {
        category: 'entertainment',
        keywords: [
            'entertainment', 'streaming', 'netflix', 'spotify', 'movie', 'music',
            'hobby', 'hobbies', 'game', 'games', 'gaming', 'recreation', 'sports',
            'concert', 'subscription',
        ],
    },
    {
        category: 'transportation',
        keywords: [
            'transportation', 'transport', 'transit', 'auto', 'automotive', 'car',
            'vehicle', 'parking', 'toll', 'tolls', 'uber', 'lyft', 'taxi', 'bus',
            'train', 'registration',
        ],
    },
    {
        category: 'housing',
        keywords: ['mortgage', 'rent', 'housing', 'hoa', 'property tax', 'home', 'homeowner', 'apartment'],
    },
    {
        category: 'food_at_home',
        keywords: ['groceries', 'grocery', 'supermarket', 'food'],
    },
];

/** Rules with keywords pre-compiled to word-boundary regexes. */
const COMPILED_RULES: Array<{ category: BlsCategoryId; patterns: RegExp[] }> =
    MAPPING_RULES.map((rule) => ({
        category: rule.category,
        patterns: rule.keywords.map(keywordRegex),
    }));

/**
 * Map an expense account path (e.g. "Expenses:Auto:Gas") to a BLS category,
 * or null when nothing matches. Compound special case: a bare "gas" segment
 * under an auto/car/vehicle path is gasoline, not utilities.
 */
export function mapAccountToBlsCategory(accountPath: string): BlsCategoryId | null {
    const path = accountPath.toLowerCase();
    if (!path.trim()) return null;

    // "Expenses:Auto:Gas" — bare 'gas' next to a vehicle word means gasoline
    if (
        /\bgas\b/.test(path) &&
        (path.includes('auto') || path.includes('car') || path.includes('vehicle'))
    ) {
        return 'gasoline';
    }

    for (const rule of COMPILED_RULES) {
        if (rule.patterns.some((pattern) => pattern.test(path))) {
            return rule.category;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Comparison math (pure)
// ---------------------------------------------------------------------------

export interface BlsComparisonRow {
    category: BlsCategoryId;
    label: string;
    /** Book spending for the selected year, USD. */
    yourSpend: number;
    /** Approximate BLS annual average for the household size, USD. */
    blsAverage: number;
    /** yourSpend / blsAverage (null when the average is 0). */
    ratio: number | null;
    /** yourSpend − blsAverage (positive = you spend more than average). */
    delta: number;
}

/** Build per-category rows sorted by |delta| descending. All 12 categories appear. */
export function computeBlsComparison(
    spendByCategory: Partial<Record<BlsCategoryId, number>>,
    householdSize: number,
): BlsComparisonRow[] {
    const rows: BlsComparisonRow[] = BLS_CATEGORIES.map((category) => {
        const yourSpend = spendByCategory[category.id] ?? 0;
        const blsAverage = getBlsAverage(category.id, householdSize);
        return {
            category: category.id,
            label: category.label,
            yourSpend,
            blsAverage,
            ratio: blsAverage > 0 ? yourSpend / blsAverage : null,
            delta: yourSpend - blsAverage,
        };
    });
    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return rows;
}

// ---------------------------------------------------------------------------
// Report generator (DB access)
// ---------------------------------------------------------------------------

export interface BlsComparisonData {
    title: string;
    generatedAt: string;
    vintage: string;
    year: number;
    householdSize: HouseholdSize;
    rows: BlsComparisonRow[];
    totals: {
        yourSpend: number;
        blsAverage: number;
        delta: number;
    };
    unmapped: {
        total: number;
        /** Largest unmapped accounts (for transparency), up to 8. */
        accounts: Array<{ path: string; amount: number }>;
    };
}

/** Build "A:B:C" paths (excluding the ROOT segment) for a set of accounts. */
function buildAccountPaths(
    accounts: Array<{ guid: string; name: string; parent_guid: string | null; account_type: string }>,
): Map<string, string> {
    const byGuid = new Map(accounts.map((a) => [a.guid, a]));
    const paths = new Map<string, string>();

    const pathOf = (guid: string, depth = 0): string => {
        if (paths.has(guid)) return paths.get(guid)!;
        const account = byGuid.get(guid);
        if (!account || depth > 50) return '';
        if (account.account_type === 'ROOT') return '';
        const parentPath = account.parent_guid ? pathOf(account.parent_guid, depth + 1) : '';
        const full = parentPath ? `${parentPath}:${account.name}` : account.name;
        paths.set(guid, full);
        return full;
    };

    for (const account of accounts) pathOf(account.guid);
    return paths;
}

export async function compareToBls(
    bookAccountGuids: string[],
    year: number,
    householdSize: number,
): Promise<BlsComparisonData> {
    const size = clampHouseholdSize(householdSize);

    const base: BlsComparisonData = {
        title: 'Spending vs National Averages (BLS)',
        generatedAt: new Date().toISOString(),
        vintage: BLS_VINTAGE,
        year,
        householdSize: size,
        rows: computeBlsComparison({}, size),
        totals: { yourSpend: 0, blsAverage: 0, delta: 0 },
        unmapped: { total: 0, accounts: [] },
    };
    base.totals.blsAverage = base.rows.reduce((sum, r) => sum + r.blsAverage, 0);
    base.totals.delta = -base.totals.blsAverage;

    if (bookAccountGuids.length === 0) return base;

    const accounts = await prisma.accounts.findMany({
        where: { guid: { in: bookAccountGuids } },
        select: { guid: true, name: true, parent_guid: true, account_type: true },
    });

    const expenseGuids = accounts
        .filter((a) => a.account_type === 'EXPENSE')
        .map((a) => a.guid);
    if (expenseGuids.length === 0) return base;

    const start = new Date(`${year}-01-01T00:00:00Z`);
    const end = new Date(`${year}-12-31T23:59:59Z`);

    const sums = await prisma.$queryRaw<Array<{ account_guid: string; amount: number | null }>>`
        SELECT s.account_guid,
               SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric)::float8 AS amount
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${expenseGuids})
          AND t.post_date >= ${start}
          AND t.post_date <= ${end}
        GROUP BY s.account_guid
    `;

    const paths = buildAccountPaths(accounts);

    const spendByCategory: Partial<Record<BlsCategoryId, number>> = {};
    let unmappedTotal = 0;
    const unmappedAccounts: Array<{ path: string; amount: number }> = [];

    for (const row of sums) {
        const amount = Number(row.amount ?? 0);
        if (!Number.isFinite(amount) || amount === 0) continue;
        const path = paths.get(row.account_guid) ?? '';
        const category = mapAccountToBlsCategory(path);
        if (category) {
            spendByCategory[category] = (spendByCategory[category] ?? 0) + amount;
        } else {
            unmappedTotal += amount;
            unmappedAccounts.push({ path: path || row.account_guid, amount });
        }
    }

    unmappedAccounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

    const rows = computeBlsComparison(spendByCategory, size);
    const yourSpend = rows.reduce((sum, r) => sum + r.yourSpend, 0);
    const blsAverage = rows.reduce((sum, r) => sum + r.blsAverage, 0);

    return {
        ...base,
        rows,
        totals: { yourSpend, blsAverage, delta: yourSpend - blsAverage },
        unmapped: { total: unmappedTotal, accounts: unmappedAccounts.slice(0, 8) },
    };
}
