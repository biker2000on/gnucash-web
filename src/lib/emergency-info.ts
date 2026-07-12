/**
 * In Case of Emergency Package
 *
 * Per-account emergency metadata (institution, beneficiary, contact,
 * login-location hint, notes) plus book-level free-text sections (executor,
 * attorney, insurance, instructions), assembled into a printable package of
 * every real-money account with its current balance, grouped by institution.
 *
 * Storage uses two lazily-created tables (the GnuCash schema itself is never
 * modified) following the advisory-lock pattern from notifications.ts:
 *   - gnucash_web_account_emergency_info  (account_guid PK)
 *   - gnucash_web_book_emergency_info     (book_guid PK, one row per book)
 *
 * The package assembly itself (`assembleEmergencyPackage`) is pure so it can
 * be unit tested without a database.
 */

import prisma from '@/lib/prisma';
import { fetchAccountCurrentValues } from '@/lib/account-current-value';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Account types included in the emergency package. */
export const EMERGENCY_ACCOUNT_TYPES = [
    'ASSET', 'BANK', 'LIABILITY', 'STOCK', 'MUTUAL', 'CREDIT',
] as const;

const EMERGENCY_TYPE_SET = new Set<string>(EMERGENCY_ACCOUNT_TYPES);
const LIABILITY_TYPES = new Set(['LIABILITY', 'CREDIT']);

export interface AccountEmergencyInfo {
    accountGuid: string;
    /** Institution holding the account ("Fidelity", "Chase", ...). */
    institution: string | null;
    /** Beneficiary / TOD / joint-owner information. */
    beneficiary: string | null;
    /** Contact person and/or phone number for the institution. */
    contact: string | null;
    /** Where to find login credentials, e.g. "1Password — Shared vault". */
    loginHint: string | null;
    notes: string | null;
}

export interface BookEmergencySections {
    executor: string;
    attorney: string;
    insurance: string;
    instructions: string;
}

export const EMPTY_SECTIONS: BookEmergencySections = {
    executor: '',
    attorney: '',
    insurance: '',
    instructions: '',
};

/** Minimal account row needed to assemble the package (testable shape). */
export interface EmergencyAccountRow {
    guid: string;
    name: string;
    account_type: string;
    parent_guid: string | null;
    hidden: number;
    placeholder: number;
    commodity_mnemonic: string | null;
    commodity_namespace: string | null;
}

export interface EmergencyAccountEntry {
    guid: string;
    name: string;
    /** Colon-joined path below the root account. */
    path: string;
    accountType: string;
    /** Current value (account currency for cash, market value for securities). */
    balance: number;
    /** Commodity mnemonic for currency accounts (USD, EUR, ...), else null. */
    currency: string | null;
    institution: string;
    institutionSource: 'metadata' | 'hierarchy';
    beneficiary: string | null;
    contact: string | null;
    loginHint: string | null;
    notes: string | null;
    /** Whether the account appears in the printed package. */
    included: boolean;
}

export interface EmergencyInstitutionGroup {
    institution: string;
    accounts: EmergencyAccountEntry[];
    subtotal: number;
}

export interface EmergencyPackage {
    /** Balance as-of timestamp (ISO). */
    asOf: string;
    totals: { assets: number; liabilities: number; net: number };
    sections: BookEmergencySections;
    /** Included accounts grouped by institution (print view). */
    institutions: EmergencyInstitutionGroup[];
    /** Every candidate account with metadata merged (edit view). */
    accounts: EmergencyAccountEntry[];
}

/* ------------------------------------------------------------------ */
/* Lazy table creation (advisory-lock pattern from notifications.ts)   */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensureEmergencyInfoTables(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_emergency_info_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_account_emergency_info (
                    account_guid VARCHAR(32) PRIMARY KEY,
                    institution VARCHAR(255),
                    beneficiary VARCHAR(255),
                    contact VARCHAR(255),
                    login_hint VARCHAR(255),
                    notes TEXT,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  );

                  CREATE TABLE IF NOT EXISTS gnucash_web_book_emergency_info (
                    book_guid VARCHAR(32) PRIMARY KEY,
                    executor TEXT,
                    attorney TEXT,
                    insurance TEXT,
                    instructions TEXT,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  );
                END $$;
            `);
        })();
    }
    return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

interface AccountInfoRow {
    account_guid: string;
    institution: string | null;
    beneficiary: string | null;
    contact: string | null;
    login_hint: string | null;
    notes: string | null;
}

function rowToInfo(row: AccountInfoRow): AccountEmergencyInfo {
    return {
        accountGuid: row.account_guid,
        institution: row.institution,
        beneficiary: row.beneficiary,
        contact: row.contact,
        loginHint: row.login_hint,
        notes: row.notes,
    };
}

/** Load emergency metadata for a set of accounts, keyed by account guid. */
export async function getAccountEmergencyInfoMap(
    accountGuids: string[],
): Promise<Map<string, AccountEmergencyInfo>> {
    await ensureEmergencyInfoTables();
    if (accountGuids.length === 0) return new Map();

    const rows = await prisma.$queryRaw<AccountInfoRow[]>`
        SELECT account_guid, institution, beneficiary, contact, login_hint, notes
        FROM gnucash_web_account_emergency_info
        WHERE account_guid = ANY(${accountGuids}::text[])
    `;
    return new Map(rows.map(row => [row.account_guid, rowToInfo(row)]));
}

function normalize(value: unknown, maxLength = 255): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
}

/**
 * Upsert per-account emergency metadata. When every field is empty the row
 * is deleted instead (keeps the lazy table tidy).
 */
export async function upsertAccountEmergencyInfo(
    accountGuid: string,
    info: Partial<Omit<AccountEmergencyInfo, 'accountGuid'>>,
): Promise<AccountEmergencyInfo> {
    await ensureEmergencyInfoTables();

    const institution = normalize(info.institution);
    const beneficiary = normalize(info.beneficiary);
    const contact = normalize(info.contact);
    const loginHint = normalize(info.loginHint);
    const notes = normalize(info.notes, 4000);

    if (!institution && !beneficiary && !contact && !loginHint && !notes) {
        await prisma.$executeRaw`
            DELETE FROM gnucash_web_account_emergency_info
            WHERE account_guid = ${accountGuid}
        `;
        return { accountGuid, institution: null, beneficiary: null, contact: null, loginHint: null, notes: null };
    }

    await prisma.$executeRaw`
        INSERT INTO gnucash_web_account_emergency_info
            (account_guid, institution, beneficiary, contact, login_hint, notes, updated_at)
        VALUES
            (${accountGuid}, ${institution}, ${beneficiary}, ${contact}, ${loginHint}, ${notes}, CURRENT_TIMESTAMP)
        ON CONFLICT (account_guid) DO UPDATE SET
            institution = EXCLUDED.institution,
            beneficiary = EXCLUDED.beneficiary,
            contact = EXCLUDED.contact,
            login_hint = EXCLUDED.login_hint,
            notes = EXCLUDED.notes,
            updated_at = CURRENT_TIMESTAMP
    `;
    return { accountGuid, institution, beneficiary, contact, loginHint, notes };
}

/** Load the book-level sections; empty strings when nothing is stored yet. */
export async function getBookEmergencySections(bookGuid: string): Promise<BookEmergencySections> {
    await ensureEmergencyInfoTables();
    const rows = await prisma.$queryRaw<Array<{
        executor: string | null;
        attorney: string | null;
        insurance: string | null;
        instructions: string | null;
    }>>`
        SELECT executor, attorney, insurance, instructions
        FROM gnucash_web_book_emergency_info
        WHERE book_guid = ${bookGuid}
        LIMIT 1
    `;
    const row = rows[0];
    return {
        executor: row?.executor ?? '',
        attorney: row?.attorney ?? '',
        insurance: row?.insurance ?? '',
        instructions: row?.instructions ?? '',
    };
}

export async function upsertBookEmergencySections(
    bookGuid: string,
    sections: Partial<BookEmergencySections>,
): Promise<BookEmergencySections> {
    await ensureEmergencyInfoTables();
    const current = await getBookEmergencySections(bookGuid);
    const next: BookEmergencySections = {
        executor: typeof sections.executor === 'string' ? sections.executor.slice(0, 8000) : current.executor,
        attorney: typeof sections.attorney === 'string' ? sections.attorney.slice(0, 8000) : current.attorney,
        insurance: typeof sections.insurance === 'string' ? sections.insurance.slice(0, 8000) : current.insurance,
        instructions: typeof sections.instructions === 'string' ? sections.instructions.slice(0, 8000) : current.instructions,
    };

    await prisma.$executeRaw`
        INSERT INTO gnucash_web_book_emergency_info
            (book_guid, executor, attorney, insurance, instructions, updated_at)
        VALUES
            (${bookGuid}, ${next.executor}, ${next.attorney}, ${next.insurance}, ${next.instructions}, CURRENT_TIMESTAMP)
        ON CONFLICT (book_guid) DO UPDATE SET
            executor = EXCLUDED.executor,
            attorney = EXCLUDED.attorney,
            insurance = EXCLUDED.insurance,
            instructions = EXCLUDED.instructions,
            updated_at = CURRENT_TIMESTAMP
    `;
    return next;
}

/* ------------------------------------------------------------------ */
/* Pure package assembly                                               */
/* ------------------------------------------------------------------ */

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

function hasAnyMetadata(info: AccountEmergencyInfo | undefined): boolean {
    if (!info) return false;
    return !!(info.institution || info.beneficiary || info.contact || info.loginHint || info.notes);
}

export interface AssembleEmergencyPackageInput {
    /** Every account in the book (used for parent-chain resolution too). */
    accounts: EmergencyAccountRow[];
    /** Current value per account guid (market value for securities). */
    values: Map<string, number>;
    /** Per-account emergency metadata keyed by account guid. */
    metadata: Map<string, AccountEmergencyInfo>;
    sections: BookEmergencySections;
    asOf: Date;
}

/**
 * Assemble the emergency package (pure).
 *
 * Candidate accounts: non-hidden, non-placeholder accounts of the
 * EMERGENCY_ACCOUNT_TYPES. A candidate is *included* in the printed package
 * when it has a non-zero current balance OR has any emergency metadata
 * recorded (so a recently-emptied account with beneficiary info still
 * prints). All candidates are returned in `accounts` for the edit view.
 *
 * Institution grouping: explicit metadata institution wins; otherwise the
 * account's top-level parent (the ancestor directly under the book root).
 */
export function assembleEmergencyPackage(input: AssembleEmergencyPackageInput): EmergencyPackage {
    const { accounts, values, metadata, sections, asOf } = input;

    const byGuid = new Map(accounts.map(a => [a.guid, a]));

    /** Names from the account up to (not including) ROOT, root-first. */
    function pathParts(account: EmergencyAccountRow): string[] {
        const parts: string[] = [];
        let current: EmergencyAccountRow | undefined = account;
        const seen = new Set<string>();
        while (current && current.account_type !== 'ROOT' && !seen.has(current.guid)) {
            seen.add(current.guid);
            parts.unshift(current.name);
            current = current.parent_guid ? byGuid.get(current.parent_guid) : undefined;
        }
        return parts;
    }

    const entries: EmergencyAccountEntry[] = [];

    for (const account of accounts) {
        if (!EMERGENCY_TYPE_SET.has(account.account_type)) continue;
        if (account.hidden !== 0 || account.placeholder !== 0) continue;

        const balance = round2(values.get(account.guid) ?? 0);
        const info = metadata.get(account.guid);
        const included = Math.abs(balance) >= 0.005 || hasAnyMetadata(info);

        const parts = pathParts(account);
        const metaInstitution = info?.institution?.trim();
        const institution = metaInstitution || parts[0] || account.name;

        entries.push({
            guid: account.guid,
            name: account.name,
            path: parts.join(':'),
            accountType: account.account_type,
            balance,
            currency: account.commodity_namespace === 'CURRENCY' ? account.commodity_mnemonic : null,
            institution,
            institutionSource: metaInstitution ? 'metadata' : 'hierarchy',
            beneficiary: info?.beneficiary ?? null,
            contact: info?.contact ?? null,
            loginHint: info?.loginHint ?? null,
            notes: info?.notes ?? null,
            included,
        });
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));

    // Group included entries by institution.
    const groups = new Map<string, EmergencyInstitutionGroup>();
    let assets = 0;
    let liabilities = 0;

    for (const entry of entries) {
        if (!entry.included) continue;
        if (LIABILITY_TYPES.has(entry.accountType)) {
            liabilities += entry.balance;
        } else {
            assets += entry.balance;
        }
        let group = groups.get(entry.institution);
        if (!group) {
            group = { institution: entry.institution, accounts: [], subtotal: 0 };
            groups.set(entry.institution, group);
        }
        group.accounts.push(entry);
        group.subtotal = round2(group.subtotal + entry.balance);
    }

    const institutions = [...groups.values()].sort((a, b) =>
        a.institution.localeCompare(b.institution));

    return {
        asOf: asOf.toISOString(),
        totals: {
            assets: round2(assets),
            liabilities: round2(liabilities),
            net: round2(assets + liabilities),
        },
        sections,
        institutions,
        accounts: entries,
    };
}

/* ------------------------------------------------------------------ */
/* Database-backed package builder                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the emergency package for the active book.
 *
 * @param bookAccountGuids - every account guid in the book (from book-scope)
 * @param bookGuid - the active book guid (for the book-level sections row)
 */
export async function buildEmergencyPackage(
    bookAccountGuids: string[],
    bookGuid: string,
): Promise<EmergencyPackage> {
    await ensureEmergencyInfoTables();
    const asOf = new Date();

    const accounts = await prisma.accounts.findMany({
        where: { guid: { in: bookAccountGuids } },
        select: {
            guid: true,
            name: true,
            account_type: true,
            parent_guid: true,
            hidden: true,
            placeholder: true,
            commodity: { select: { mnemonic: true, namespace: true } },
        },
    });

    const rows: EmergencyAccountRow[] = accounts.map(a => ({
        guid: a.guid,
        name: a.name,
        account_type: a.account_type,
        parent_guid: a.parent_guid,
        hidden: a.hidden ?? 0,
        placeholder: a.placeholder ?? 0,
        commodity_mnemonic: a.commodity?.mnemonic ?? null,
        commodity_namespace: a.commodity?.namespace ?? null,
    }));

    const candidateGuids = rows
        .filter(r => EMERGENCY_TYPE_SET.has(r.account_type) && r.hidden === 0 && r.placeholder === 0)
        .map(r => r.guid);

    const [currentValues, metadata, sections] = await Promise.all([
        fetchAccountCurrentValues(candidateGuids, asOf),
        getAccountEmergencyInfoMap(candidateGuids),
        getBookEmergencySections(bookGuid),
    ]);

    const values = new Map<string, number>();
    for (const [guid, cv] of currentValues) values.set(guid, cv.value);

    return assembleEmergencyPackage({ accounts: rows, values, metadata, sections, asOf });
}
