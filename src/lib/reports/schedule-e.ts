/**
 * Schedule E (Part I) estimate — rental real estate income and expenses.
 *
 * A "property" is a user-defined grouping: a name plus a set of account
 * SUBTREES (the user picks e.g. "Income:Rental:123 Main St" and
 * "Expenses:Rental:123 Main St"; every descendant account is included).
 * Each property also carries per-account line OVERRIDES and a list of
 * DEPRECIABLE ASSETS (straight-line, mid-month convention, 27.5-year
 * residential / 39-year commercial).
 *
 * Expense accounts map onto Schedule E lines 5–19 via keyword rules
 * (mirroring the Schedule C heuristic in `business-reports.ts`); a manual
 * override always wins. Income accounts land on line 3 "Rents received".
 * Unmatched expense accounts fall to line 19 "Other".
 *
 * Persistence reuses the Schedule C mappings pattern: the backing table is
 * NOT part of the Prisma schema (the GnuCash DB rejects `prisma db push`),
 * so it is created lazily via raw SQL under an advisory lock — the same
 * pattern as `src/lib/business/schedule-c-mappings.ts`. Do NOT add this
 * table to `db-init.ts` or `prisma/schema.prisma`.
 *
 * Structure mirrors `business-reports.ts`: PURE, unit-tested logic
 * (`src/lib/__tests__/schedule-e.test.ts`) plus thin SQL loaders.
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';

/* ------------------------------------------------------------------ */
/* Lines and keyword rules                                              */
/* ------------------------------------------------------------------ */

export const SCHEDULE_E_LINE_LABELS: Record<string, string> = {
    '3': 'Rents received',
    '5': 'Advertising',
    '6': 'Auto and travel',
    '7': 'Cleaning and maintenance',
    '8': 'Commissions',
    '9': 'Insurance',
    '10': 'Legal and other professional fees',
    '11': 'Management fees',
    '12': 'Mortgage interest paid to banks, etc.',
    '13': 'Other interest',
    '14': 'Repairs',
    '15': 'Supplies',
    '16': 'Taxes',
    '17': 'Utilities',
    '18': 'Depreciation expense or depletion',
    '19': 'Other',
};

/** Display order for the Part I expense lines. */
export const SCHEDULE_E_EXPENSE_LINE_ORDER = [
    '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19',
] as const;

/**
 * Lines a MANUAL override may target: every expense line including 18
 * (for books that post depreciation journal entries themselves) but not
 * line 3 (income always lands on Rents received).
 */
export const SCHEDULE_E_MANUAL_LINES: ReadonlySet<string> = new Set(
    SCHEDULE_E_EXPENSE_LINE_ORDER,
);

/** True when `line` is a valid manual-override Schedule E expense line. */
export function isValidScheduleELine(line: unknown): line is string {
    return typeof line === 'string' && SCHEDULE_E_MANUAL_LINES.has(line);
}

export interface ScheduleERule {
    /** Schedule E line number, e.g. '7', '14'. */
    line: string;
    pattern: RegExp;
}

/**
 * Keyword → Schedule E line rules. FIRST MATCH WINS, so more specific rules
 * come first ("Mortgage Interest" must hit line 12 before the generic
 * interest rule on 13, and "Repairs & Maintenance" hits Repairs before the
 * cleaning-and-maintenance rule). Matched against the leaf account name
 * first, then the full path — so children inherit a parent category.
 * The keyword heuristic never targets line 18; depreciation is computed
 * from the property's asset definitions (a manual override can still send
 * a booked depreciation-expense account there).
 */
export const SCHEDULE_E_RULES: ReadonlyArray<ScheduleERule> = [
    { line: '12', pattern: /mortgage/i },
    { line: '11', pattern: /management|property manager/i },
    { line: '8', pattern: /commission/i },
    { line: '14', pattern: /repair/i },
    { line: '7', pattern: /clean|maintenance|landscap|lawn|snow|pest|janitor/i },
    { line: '5', pattern: /advertis|marketing|listing/i },
    { line: '6', pattern: /travel|mileage|\bauto\b|vehicle|\bcar\b|airfare|lodging|hotel|fuel|gasoline/i },
    { line: '9', pattern: /insurance/i },
    { line: '10', pattern: /legal|attorney|lawyer|account(ing|ant)|bookkeep|\bcpa\b|professional/i },
    { line: '13', pattern: /interest|finance charge/i },
    { line: '15', pattern: /supplie|supply|material/i },
    // (?!i) keeps "Taxi" out of taxes, matching the Schedule C rule.
    { line: '16', pattern: /tax(?!i)|licen[cs]e|permit/i },
    { line: '17', pattern: /utilit|electric|water|sewer|trash|garbage|internet|phone|telephone|\bgas\b/i },
];

/**
 * Map a rental expense account to a Schedule E line via keyword rules.
 * Leaf name is checked first (most specific), then the full path.
 * Returns null when unmapped (→ line 19 "Other").
 */
export function mapRentalAccountToLine(name: string, path: string): string | null {
    for (const rule of SCHEDULE_E_RULES) {
        if (rule.pattern.test(name)) return rule.line;
    }
    for (const rule of SCHEDULE_E_RULES) {
        if (rule.pattern.test(path)) return rule.line;
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Property + asset definitions                                         */
/* ------------------------------------------------------------------ */

export type DepreciationMethod = 'residential' | 'commercial';

/** MACRS GDS straight-line recovery periods, in years. */
export const DEPRECIATION_RECOVERY_YEARS: Record<DepreciationMethod, number> = {
    residential: 27.5,
    commercial: 39,
};

export interface DepreciableAsset {
    /** 32-char hex id (client-generated or assigned on save). */
    id: string;
    description: string;
    /** Total cost basis INCLUDING land. */
    costBasis: number;
    /** Non-depreciable land portion of the cost basis. */
    landValue: number;
    /** In-service date, 'YYYY-MM-DD'. */
    inServiceDate: string;
    method: DepreciationMethod;
    /** Disposal/sale date 'YYYY-MM-DD', or null while still in service. */
    disposalDate: string | null;
}

export interface ScheduleEProperty {
    /** 32-char hex id. */
    id: string;
    name: string;
    /** GUIDs of the account SUBTREE ROOTS that belong to this property. */
    accountGuids: string[];
    /** Manual per-account line overrides: account guid → Schedule E line. */
    overrides: Record<string, string>;
    assets: DepreciableAsset[];
}

/* ------------------------------------------------------------------ */
/* Pure — depreciation (straight line, mid-month convention)            */
/* ------------------------------------------------------------------ */

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse 'YYYY-MM-DD' → { y, m } (m 1-12), or null when malformed. */
export function parseYearMonth(date: string): { y: number; m: number } | null {
    const match = YMD_RE.exec(date);
    if (!match) return null;
    const y = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const d = parseInt(match[3], 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y, m };
}

/**
 * Straight-line depreciation allowed for `asset` in calendar tax year `year`,
 * under the MID-MONTH convention: the in-service month and the disposal month
 * each count as half a month of service. Implemented in exact service-month
 * arithmetic — first year = basis × (12.5 − inServiceMonth) / recoveryMonths,
 * a full year = basis / recoveryYears, disposal year =
 * basis × (disposalMonth − 0.5) / 12 / recoveryYears — and capped at the
 * total recovery period (330 months residential, 468 commercial), so the
 * final recovery year automatically takes only the remainder. Pure.
 */
export function depreciationForYear(asset: DepreciableAsset, year: number): number {
    const inService = parseYearMonth(asset.inServiceDate);
    if (!inService) return 0;

    const basis = (asset.costBasis ?? 0) - (asset.landValue ?? 0);
    if (!Number.isFinite(basis) || basis <= 0) return 0;

    const recoveryMonths = DEPRECIATION_RECOVERY_YEARS[asset.method] * 12; // 330 | 468
    const inServiceIdx = inService.y * 12 + (inService.m - 1);

    // Service months elapsed from the MID of the in-service month through the
    // END of the given calendar year (>= 0).
    const serviceThroughEndOf = (y: number): number =>
        Math.max(0, y * 12 + 11 - inServiceIdx + 0.5);

    // Service ends at the earlier of full recovery or the disposal mid-month.
    let serviceCap = recoveryMonths;
    const disposal = asset.disposalDate ? parseYearMonth(asset.disposalDate) : null;
    if (disposal) {
        serviceCap = Math.min(
            serviceCap,
            Math.max(0, disposal.y * 12 + (disposal.m - 1) - inServiceIdx),
        );
    }

    const monthsThroughYear = Math.min(serviceThroughEndOf(year), serviceCap);
    const monthsThroughPrior = Math.min(serviceThroughEndOf(year - 1), serviceCap);
    const months = monthsThroughYear - monthsThroughPrior;
    if (months <= 0) return 0;

    return round2((basis * months) / recoveryMonths);
}

/* ------------------------------------------------------------------ */
/* Pure — report assembly                                               */
/* ------------------------------------------------------------------ */

export interface ScheduleEAccountInput {
    guid: string;
    name: string;
    /** Full account path, e.g. "Expenses:Rental:123 Main St:Repairs". */
    path: string;
    type: 'INCOME' | 'EXPENSE';
    /** Raw split-value sum for the year (income negative, expenses positive). */
    total: number;
}

export interface ScheduleEAccountDetail {
    guid: string;
    name: string;
    path: string;
    amount: number;
    /** Keyword-heuristic line (null when no keyword matched). Income = '3'. */
    suggestedLine: string | null;
    /** Effective line after applying the property's manual overrides. */
    mappedLine: string;
}

export interface ScheduleELine {
    line: string;
    label: string;
    amount: number;
    accounts: ScheduleEAccountDetail[];
}

export interface ScheduleEAssetDetail {
    id: string;
    description: string;
    method: DepreciationMethod;
    inServiceDate: string;
    /** Depreciation allowed for the report's tax year. */
    depreciation: number;
}

export interface ScheduleEPropertyReport {
    id: string;
    name: string;
    /** Line 3 — rents received, sign-corrected to read positive. */
    rentsReceived: number;
    incomeAccounts: ScheduleEAccountDetail[];
    /** Expense lines in SCHEDULE_E_EXPENSE_LINE_ORDER (zero lines included). */
    lines: ScheduleELine[];
    /** Asset-computed portion of line 18 with per-asset breakdown. */
    assets: ScheduleEAssetDetail[];
    assetDepreciation: number;
    /** Line 20 — total expenses (lines 5 through 19). */
    totalExpenses: number;
    /** Line 21 — income or (loss). */
    netIncome: number;
    /** Expense accounts that fell through to line 19 with no keyword match. */
    unmappedCount: number;
    /** Expense accounts whose line came from a manual override. */
    overriddenCount: number;
}

export interface ScheduleEReport {
    year: number;
    properties: ScheduleEPropertyReport[];
    /** Combined Part I summary across all properties. */
    totals: {
        rentsReceived: number;
        totalExpenses: number;
        /** Combined line 18 (asset-computed + manually mapped accounts). */
        depreciation: number;
        netIncome: number;
    };
    unmappedCount: number;
    overriddenCount: number;
}

/**
 * Resolve each property's member accounts by expanding its selected subtree
 * roots: an account belongs to a property when it IS one of the selected
 * roots or its path descends from one (path-prefix on ':'-separated
 * fullnames). An account claimed by more than one property counts only for
 * the FIRST property (definition order) so the combined summary never
 * double-counts. Pure.
 */
export function resolvePropertyMembers(
    properties: ReadonlyArray<ScheduleEProperty>,
    accounts: ReadonlyArray<ScheduleEAccountInput>,
): Map<string, ScheduleEAccountInput[]> {
    const byGuid = new Map(accounts.map((a) => [a.guid, a]));
    const claimed = new Set<string>();
    const members = new Map<string, ScheduleEAccountInput[]>();

    for (const property of properties) {
        const roots = property.accountGuids
            .map((guid) => byGuid.get(guid))
            .filter((a): a is ScheduleEAccountInput => a !== undefined);
        const rootGuids = new Set(roots.map((r) => r.guid));
        const prefixes = roots.map((r) => `${r.path}:`);

        const list: ScheduleEAccountInput[] = [];
        for (const acct of accounts) {
            if (claimed.has(acct.guid)) continue;
            if (rootGuids.has(acct.guid) || prefixes.some((p) => acct.path.startsWith(p))) {
                claimed.add(acct.guid);
                list.push(acct);
            }
        }
        members.set(property.id, list);
    }

    return members;
}

/**
 * Build the Schedule E Part I estimate for a tax year. Pure.
 *
 * Income accounts land on line 3 (credits negated to read positive).
 * Expense accounts land on a line 5–19: a valid manual override WINS over
 * the keyword heuristic; unmatched accounts fall to line 19 "Other".
 * Line 18 additionally receives each asset's computed straight-line
 * mid-month depreciation for the year. This is an ESTIMATE, not filing
 * advice.
 */
export function buildScheduleE(
    year: number,
    properties: ReadonlyArray<ScheduleEProperty>,
    accounts: ReadonlyArray<ScheduleEAccountInput>,
): ScheduleEReport {
    const membersByProperty = resolvePropertyMembers(properties, accounts);

    const propertyReports: ScheduleEPropertyReport[] = [];
    const totals = { rentsReceived: 0, totalExpenses: 0, depreciation: 0, netIncome: 0 };
    let unmappedTotal = 0;
    let overriddenTotal = 0;

    for (const property of properties) {
        const lineMap = new Map<string, ScheduleELine>();
        for (const line of SCHEDULE_E_EXPENSE_LINE_ORDER) {
            lineMap.set(line, {
                line,
                label: SCHEDULE_E_LINE_LABELS[line],
                amount: 0,
                accounts: [],
            });
        }

        let rentsReceived = 0;
        const incomeAccounts: ScheduleEAccountDetail[] = [];
        let unmappedCount = 0;
        let overriddenCount = 0;

        for (const acct of membersByProperty.get(property.id) ?? []) {
            if (Math.abs(acct.total) < 0.005) continue;

            if (acct.type === 'INCOME') {
                // GnuCash stores income as credits (negative) — negate for display.
                const amount = round2(-acct.total);
                rentsReceived = round2(rentsReceived + amount);
                incomeAccounts.push({
                    guid: acct.guid, name: acct.name, path: acct.path, amount,
                    suggestedLine: '3', mappedLine: '3',
                });
                continue;
            }

            const suggested = mapRentalAccountToLine(acct.name, acct.path);
            const override = property.overrides[acct.guid];
            const overridden = isValidScheduleELine(override);
            const lineNo = overridden ? override : (suggested ?? '19');
            if (overridden) overriddenCount++;
            else if (!suggested) unmappedCount++;

            const line = lineMap.get(lineNo)!;
            const amount = round2(acct.total);
            line.amount = round2(line.amount + amount);
            line.accounts.push({
                guid: acct.guid, name: acct.name, path: acct.path, amount,
                suggestedLine: suggested, mappedLine: lineNo,
            });
        }

        const assets: ScheduleEAssetDetail[] = property.assets.map((asset) => ({
            id: asset.id,
            description: asset.description,
            method: asset.method,
            inServiceDate: asset.inServiceDate,
            depreciation: depreciationForYear(asset, year),
        }));
        const assetDepreciation = round2(assets.reduce((s, a) => s + a.depreciation, 0));

        const line18 = lineMap.get('18')!;
        line18.amount = round2(line18.amount + assetDepreciation);

        let totalExpenses = 0;
        for (const line of lineMap.values()) {
            totalExpenses = round2(totalExpenses + line.amount);
            line.accounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
        }
        incomeAccounts.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

        const netIncome = round2(rentsReceived - totalExpenses);

        propertyReports.push({
            id: property.id,
            name: property.name,
            rentsReceived,
            incomeAccounts,
            lines: SCHEDULE_E_EXPENSE_LINE_ORDER.map((l) => lineMap.get(l)!),
            assets,
            assetDepreciation,
            totalExpenses,
            netIncome,
            unmappedCount,
            overriddenCount,
        });

        totals.rentsReceived = round2(totals.rentsReceived + rentsReceived);
        totals.totalExpenses = round2(totals.totalExpenses + totalExpenses);
        totals.depreciation = round2(totals.depreciation + line18.amount);
        totals.netIncome = round2(totals.netIncome + netIncome);
        unmappedTotal += unmappedCount;
        overriddenTotal += overriddenCount;
    }

    return {
        year,
        properties: propertyReports,
        totals,
        unmappedCount: unmappedTotal,
        overriddenCount: overriddenTotal,
    };
}

/* ------------------------------------------------------------------ */
/* Pure — property validation                                           */
/* ------------------------------------------------------------------ */

/** Thrown by `validateProperties` for malformed property definitions. */
export class ScheduleEValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ScheduleEValidationError';
    }
}

const HEX32_RE = /^[0-9a-f]{32}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAsset(raw: unknown, propertyName: string): DepreciableAsset {
    if (!isRecord(raw)) {
        throw new ScheduleEValidationError(`Malformed asset on property "${propertyName}"`);
    }
    const description =
        typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description || description.length > 200) {
        throw new ScheduleEValidationError(
            `Asset on property "${propertyName}" needs a description (max 200 chars)`,
        );
    }
    const costBasis = raw.costBasis;
    if (typeof costBasis !== 'number' || !Number.isFinite(costBasis) || costBasis <= 0) {
        throw new ScheduleEValidationError(
            `Asset "${description}" needs a positive cost basis`,
        );
    }
    const landValue = raw.landValue ?? 0;
    if (typeof landValue !== 'number' || !Number.isFinite(landValue) || landValue < 0) {
        throw new ScheduleEValidationError(
            `Asset "${description}" has an invalid land value`,
        );
    }
    if (landValue > costBasis) {
        throw new ScheduleEValidationError(
            `Asset "${description}": land value cannot exceed the cost basis`,
        );
    }
    const inServiceDate = typeof raw.inServiceDate === 'string' ? raw.inServiceDate : '';
    const inService = parseYearMonth(inServiceDate);
    if (!inService) {
        throw new ScheduleEValidationError(
            `Asset "${description}" needs an in-service date (YYYY-MM-DD)`,
        );
    }
    const method = raw.method;
    if (method !== 'residential' && method !== 'commercial') {
        throw new ScheduleEValidationError(
            `Asset "${description}" has an invalid depreciation method`,
        );
    }
    let disposalDate: string | null = null;
    if (raw.disposalDate != null && raw.disposalDate !== '') {
        if (typeof raw.disposalDate !== 'string' || !parseYearMonth(raw.disposalDate)) {
            throw new ScheduleEValidationError(
                `Asset "${description}" has an invalid disposal date`,
            );
        }
        if (raw.disposalDate < inServiceDate) {
            throw new ScheduleEValidationError(
                `Asset "${description}": disposal date is before the in-service date`,
            );
        }
        disposalDate = raw.disposalDate;
    }
    const id =
        typeof raw.id === 'string' && HEX32_RE.test(raw.id) ? raw.id : generateGuid();
    return { id, description, costBasis, landValue, inServiceDate, method, disposalDate };
}

/**
 * PURE. Validate and normalize a client-submitted property list.
 *   - Names must be non-empty (max 120 chars).
 *   - Every account guid (subtree roots and override keys) must be a 32-char
 *     GUID within `bookAccountGuids`; roots are de-duplicated.
 *   - Override lines must be valid Schedule E expense lines.
 *   - Assets are validated per `validateAsset`; missing ids are generated.
 * Throws `ScheduleEValidationError` on the first invalid entry.
 */
export function validateProperties(
    input: unknown,
    bookAccountGuids: ReadonlySet<string>,
): ScheduleEProperty[] {
    if (!Array.isArray(input)) {
        throw new ScheduleEValidationError('Properties must be an array');
    }

    const seenIds = new Set<string>();
    const properties: ScheduleEProperty[] = [];

    for (const raw of input) {
        if (!isRecord(raw)) {
            throw new ScheduleEValidationError('Malformed property entry');
        }
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        if (!name || name.length > 120) {
            throw new ScheduleEValidationError(
                'Each property needs a name (max 120 chars)',
            );
        }

        let id =
            typeof raw.id === 'string' && HEX32_RE.test(raw.id) ? raw.id : generateGuid();
        while (seenIds.has(id)) id = generateGuid();
        seenIds.add(id);

        const rawGuids = Array.isArray(raw.accountGuids) ? raw.accountGuids : [];
        const accountGuids: string[] = [];
        for (const guid of rawGuids) {
            if (typeof guid !== 'string' || guid.length !== 32 || !bookAccountGuids.has(guid)) {
                throw new ScheduleEValidationError(
                    `Property "${name}": invalid or out-of-book account guid: ${String(guid)}`,
                );
            }
            if (!accountGuids.includes(guid)) accountGuids.push(guid);
        }

        const overrides: Record<string, string> = {};
        if (raw.overrides != null) {
            if (!isRecord(raw.overrides)) {
                throw new ScheduleEValidationError(
                    `Property "${name}": overrides must be an object`,
                );
            }
            for (const [guid, line] of Object.entries(raw.overrides)) {
                if (guid.length !== 32 || !bookAccountGuids.has(guid)) {
                    throw new ScheduleEValidationError(
                        `Property "${name}": override for invalid or out-of-book account guid: ${guid}`,
                    );
                }
                if (!isValidScheduleELine(line)) {
                    throw new ScheduleEValidationError(
                        `Property "${name}": invalid Schedule E line: ${String(line)}`,
                    );
                }
                overrides[guid] = line;
            }
        }

        const rawAssets = Array.isArray(raw.assets) ? raw.assets : [];
        const assets = rawAssets.map((a) => validateAsset(a, name));

        properties.push({ id, name, accountGuids, overrides, assets });
    }

    return properties;
}

/* ------------------------------------------------------------------ */
/* Lazy table creation (Schedule C mappings pattern, distinct key)      */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensureScheduleEPropertiesTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                    PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_schedule_e_properties_schema'));

                    CREATE TABLE IF NOT EXISTS gnucash_web_schedule_e_properties (
                        id VARCHAR(32) PRIMARY KEY,
                        book_root_guid VARCHAR(32) NOT NULL,
                        data JSONB NOT NULL,
                        created_at TIMESTAMP DEFAULT now(),
                        updated_at TIMESTAMP DEFAULT now()
                    );

                    CREATE INDEX IF NOT EXISTS gnucash_web_schedule_e_properties_book_idx
                        ON gnucash_web_schedule_e_properties (book_root_guid);
                END $$;
            `);
        })();
    }
    return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* Read / write                                                         */
/* ------------------------------------------------------------------ */

/** Tolerant reader for a stored JSONB payload; null when unusable. */
function readStoredProperty(id: string, data: unknown): ScheduleEProperty | null {
    if (!isRecord(data)) return null;
    const name = typeof data.name === 'string' ? data.name : '';
    if (!name) return null;

    const accountGuids = Array.isArray(data.accountGuids)
        ? data.accountGuids.filter((g): g is string => typeof g === 'string')
        : [];

    const overrides: Record<string, string> = {};
    if (isRecord(data.overrides)) {
        for (const [guid, line] of Object.entries(data.overrides)) {
            if (isValidScheduleELine(line)) overrides[guid] = line;
        }
    }

    const assets: DepreciableAsset[] = [];
    if (Array.isArray(data.assets)) {
        for (const raw of data.assets) {
            try {
                assets.push(validateAsset(raw, name));
            } catch {
                // Skip assets that no longer validate rather than break the report.
            }
        }
    }

    return { id, name, accountGuids, overrides, assets };
}

/** Stored property definitions for a book, in creation order. */
export async function getProperties(bookRootGuid: string): Promise<ScheduleEProperty[]> {
    await ensureScheduleEPropertiesTable();

    const rows = await prisma.$queryRaw<Array<{ id: string; data: unknown }>>`
        SELECT id, data
        FROM gnucash_web_schedule_e_properties
        WHERE book_root_guid = ${bookRootGuid}
        ORDER BY created_at, id
    `;

    const properties: ScheduleEProperty[] = [];
    for (const row of rows) {
        const property = readStoredProperty(row.id, row.data);
        if (property) properties.push(property);
    }
    return properties;
}

/**
 * Replace the book's property definitions with `input` (full-set PUT
 * semantics, like the Schedule C mappings batch save). Validates via
 * `validateProperties` (throws `ScheduleEValidationError`) before touching
 * the DB; properties absent from `input` are deleted.
 */
export async function saveProperties(
    input: unknown,
    bookRootGuid: string,
    bookAccountGuids: string[],
): Promise<ScheduleEProperty[]> {
    const properties = validateProperties(input, new Set(bookAccountGuids));

    await ensureScheduleEPropertiesTable();

    const keepIds = properties.map((p) => p.id);
    await prisma.$executeRaw`
        DELETE FROM gnucash_web_schedule_e_properties
        WHERE book_root_guid = ${bookRootGuid}
          AND id != ALL(${keepIds}::text[])
    `;

    for (const property of properties) {
        await prisma.$executeRaw`
            INSERT INTO gnucash_web_schedule_e_properties (id, book_root_guid, data)
            VALUES (${property.id}, ${bookRootGuid}, ${JSON.stringify(property)}::jsonb)
            ON CONFLICT (id) DO UPDATE
                SET data = EXCLUDED.data,
                    book_root_guid = EXCLUDED.book_root_guid,
                    updated_at = now()
        `;
    }

    return properties;
}

/* ------------------------------------------------------------------ */
/* SQL loader + report generation                                       */
/* ------------------------------------------------------------------ */

/**
 * Every INCOME/EXPENSE account in the book with its split-value total for
 * the tax year. Zero-activity accounts are INCLUDED — a property's selected
 * subtree root may be a placeholder with no splits of its own, and its
 * fullname is needed to expand the subtree.
 */
export async function loadScheduleEAccounts(
    bookAccountGuids: string[],
    year: number,
): Promise<ScheduleEAccountInput[]> {
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    const rows = await prisma.$queryRaw<
        { guid: string; name: string; fullname: string; account_type: string; total: number }[]
    >`
        SELECT
            ah.guid,
            ah.name,
            ah.fullname,
            ah.account_type,
            COALESCE(
                SUM(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric)
                    FILTER (WHERE t.post_date >= ${start} AND t.post_date <= ${end}),
                0
            )::float8 AS total
        FROM account_hierarchy ah
        LEFT JOIN splits s ON s.account_guid = ah.guid
        LEFT JOIN transactions t ON t.guid = s.tx_guid
        WHERE ah.guid = ANY(${bookAccountGuids}::text[])
          AND ah.account_type IN ('INCOME', 'EXPENSE')
        GROUP BY ah.guid, ah.name, ah.fullname, ah.account_type
    `;

    return rows.map((r) => ({
        guid: r.guid,
        name: r.name,
        path: r.fullname,
        type: r.account_type as 'INCOME' | 'EXPENSE',
        total: r.total,
    }));
}

/**
 * Schedule E Part I estimate for a tax year across the book's defined
 * rental properties. Works for ANY book (rentals are common on household
 * books), so callers must not gate this on the business entity type.
 */
export async function generateScheduleE(
    bookAccountGuids: string[],
    bookRootGuid: string,
    year: number,
): Promise<ScheduleEReport> {
    const [properties, accounts] = await Promise.all([
        getProperties(bookRootGuid),
        loadScheduleEAccounts(bookAccountGuids, year),
    ]);
    return buildScheduleE(year, properties, accounts);
}
