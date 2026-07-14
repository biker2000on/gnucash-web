/**
 * Prepaid Packages (deferred revenue) service.
 *
 * A package sale books cash against a liability ("unearned revenue"):
 *   DEBIT  bank            +price
 *   CREDIT liability       -price
 * Each redeemed session recognizes a slice of that liability as income:
 *   DEBIT  liability       +amount
 *   CREDIT income          -amount
 * where amount = price / sessions_total per session (rounded to the currency
 * fraction) and the FINAL redemption absorbs the rounding remainder so the
 * liability zeroes out exactly.
 *
 * Package metadata lives in gnucash_web_packages / _package_redemptions;
 * the money itself is plain GnuCash transactions (visible in the desktop
 * app), linked via sale_txn_guid / redemptions.txn_guid.
 */

import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal, toDecimalNumber } from '@/lib/gnucash';
import { getAccountGuidsForBook } from '@/lib/book-scope';

export type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Caller-fixable input problem — HTTP 400. */
export class PackageValidationError extends Error {}
/** Missing entity — HTTP 404. */
export class PackageNotFoundError extends Error {}
/** Valid request, wrong state (e.g. redeeming past the total) — HTTP 409. */
export class PackageStateError extends Error {}

const DEFAULT_LIABILITY_PATH = 'Liabilities:Unearned Revenue:Packages';
const DEFAULT_INCOME_PATH = 'Income:Package Revenue';

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

/** Round half-away-from-zero to the currency fraction (100 => cents). */
export function roundToFraction(value: number, fraction: number = 100): number {
    const sign = value < 0 ? -1 : 1;
    return (sign * Math.round(Math.abs(value) * fraction)) / fraction;
}

/**
 * Amount to recognize for a redemption of `sessions` sessions.
 *
 * Normal redemptions recognize round(price / sessionsTotal * sessions).
 * The redemption that exhausts the package instead recognizes
 * price - sum(priorAmounts), so the liability balance lands on exactly zero
 * regardless of per-session rounding.
 */
export function computeRedemptionAmount(
    price: number,
    sessionsTotal: number,
    sessions: number,
    redeemedBefore: number,
    priorAmounts: ReadonlyArray<number>,
    fraction: number = 100,
): number {
    if (sessionsTotal <= 0) return 0;
    const isFinal = redeemedBefore + sessions >= sessionsTotal;
    if (isFinal) {
        const prior = priorAmounts.reduce((s, v) => s + v, 0);
        return roundToFraction(price - prior, fraction);
    }
    return roundToFraction((price / sessionsTotal) * sessions, fraction);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SellPackageInput {
    name: string;
    clientName?: string;
    customerGuid?: string;
    sessionsTotal: number;
    price: number;
    /** ISO date (YYYY-MM-DD). */
    soldDate: string;
    bankAccountGuid: string;
    liabilityAccountGuid?: string;
    incomeAccountGuid?: string;
    notes?: string;
}

export interface UpdatePackageInput {
    name?: string;
    clientName?: string | null;
    customerGuid?: string | null;
    notes?: string | null;
}

export interface RedeemSessionInput {
    /** ISO date (YYYY-MM-DD); defaults to today. */
    date?: string;
    sessions?: number;
    notes?: string;
}

export interface RedemptionView {
    id: number;
    date: string;
    sessions: number;
    /** Income recognized by this redemption (positive). */
    amount: number;
    txnGuid: string | null;
    notes: string | null;
}

export interface PackageView {
    id: number;
    name: string;
    clientName: string | null;
    customerGuid: string | null;
    sessionsTotal: number;
    price: number;
    soldDate: string;
    redeemedSessions: number;
    remainingSessions: number;
    /** Recognized income to date (positive). */
    redeemedValue: number;
    /** Remaining deferred-revenue liability (positive; 0 when exhausted). */
    liabilityBalance: number;
    liabilityAccountGuid: string | null;
    incomeAccountGuid: string | null;
    saleTxnGuid: string | null;
    notes: string | null;
}

export interface PackageDetailView extends PackageView {
    redemptions: RedemptionView[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseIsoDateNoon(value: string, field: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) {
        throw new PackageValidationError(`Invalid ${field}: expected YYYY-MM-DD, got '${value}'`);
    }
    const d = new Date(`${value}T12:00:00Z`);
    if (isNaN(d.getTime())) throw new PackageValidationError(`Invalid ${field}: '${value}'`);
    return d;
}

function isoDate(d: Date | null | undefined): string {
    return d ? d.toISOString().slice(0, 10) : '';
}

async function getBookRootGuid(db: PrismaTx, bookGuid: string): Promise<string> {
    const book = await db.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) throw new PackageNotFoundError(`Book not found: ${bookGuid}`);
    return book.root_account_guid;
}

async function getCurrencyFraction(db: PrismaTx, currencyGuid: string): Promise<number> {
    const c = await db.commodities.findUnique({
        where: { guid: currencyGuid },
        select: { fraction: true },
    });
    return c?.fraction || 100;
}

/**
 * Find or create an account by colon-delimited path with an EXPLICIT account
 * type. (findOrCreateAccount in src/lib/gnucash.ts hardcodes INCOME, so
 * liability accounts must be created here.) Intermediate segments are created
 * as placeholders of the same type; existing accounts are reused as-is.
 */
export async function ensureTypedAccount(
    db: PrismaTx,
    path: string,
    bookRootGuid: string,
    currencyGuid: string,
    accountType: 'LIABILITY' | 'INCOME',
): Promise<string> {
    const segments = path.split(':');
    let parentGuid = bookRootGuid;

    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const isLast = i === segments.length - 1;

        const existing = await db.accounts.findFirst({
            where: { name: segment, parent_guid: parentGuid },
            select: { guid: true },
        });
        if (existing) {
            parentGuid = existing.guid;
            continue;
        }

        const newGuid = generateGuid();
        await db.accounts.create({
            data: {
                guid: newGuid,
                name: segment,
                account_type: accountType,
                commodity_guid: currencyGuid,
                commodity_scu: 100,
                non_std_scu: 0,
                parent_guid: parentGuid,
                hidden: 0,
                placeholder: isLast ? 0 : 1,
                code: '',
                description: '',
            },
        });
        parentGuid = newGuid;
    }

    return parentGuid;
}

/** Create a balanced two-split transaction (same-currency, value == quantity). */
async function createTwoSplitTxn(
    db: PrismaTx,
    opts: {
        currencyGuid: string;
        fraction: number;
        postDate: Date;
        description: string;
        debitAccountGuid: string;
        creditAccountGuid: string;
        amount: number;
        memo?: string;
    },
): Promise<string> {
    const txnGuid = generateGuid();
    await db.transactions.create({
        data: {
            guid: txnGuid,
            currency_guid: opts.currencyGuid,
            num: '',
            post_date: opts.postDate,
            enter_date: new Date(),
            description: opts.description,
        },
    });
    const frac = fromDecimal(opts.amount, opts.fraction);
    const negFrac = fromDecimal(-opts.amount, opts.fraction);
    for (const spec of [
        { accountGuid: opts.debitAccountGuid, num: frac.num },
        { accountGuid: opts.creditAccountGuid, num: negFrac.num },
    ]) {
        await db.splits.create({
            data: {
                guid: generateGuid(),
                tx_guid: txnGuid,
                account_guid: spec.accountGuid,
                memo: opts.memo ?? '',
                action: '',
                reconcile_state: 'n',
                reconcile_date: null,
                value_num: spec.num,
                value_denom: frac.denom,
                quantity_num: spec.num,
                quantity_denom: frac.denom,
                lot_guid: null,
            },
        });
    }
    return txnGuid;
}

/** Delete a GnuCash transaction with its splits and slots (idempotent). */
async function deleteTxn(db: PrismaTx, txnGuid: string): Promise<void> {
    await db.splits.deleteMany({ where: { tx_guid: txnGuid } });
    await db.slots.deleteMany({ where: { obj_guid: txnGuid } });
    await db.transactions.deleteMany({ where: { guid: txnGuid } });
}

type PackageRow = NonNullable<Awaited<ReturnType<typeof prisma.gnucash_web_packages.findUnique>>>;
type RedemptionRow = NonNullable<
    Awaited<ReturnType<typeof prisma.gnucash_web_package_redemptions.findUnique>>
>;

/**
 * Per-redemption recognized amounts. Reads the actual liability-account debit
 * of each redemption transaction so amounts survive edits made elsewhere;
 * falls back to the per-session formula for redemptions without a linked txn.
 */
async function redemptionAmounts(
    db: PrismaTx,
    pkg: PackageRow,
    redemptions: RedemptionRow[],
): Promise<Map<number, number>> {
    const txnGuids = redemptions.map((r) => r.txn_guid).filter((g): g is string => Boolean(g));
    const byTxn = new Map<string, number>();
    if (txnGuids.length > 0 && pkg.liability_account_guid) {
        const splits: Array<{ tx_guid: string; value_num: bigint; value_denom: bigint }> =
            await db.splits.findMany({
                where: { tx_guid: { in: txnGuids }, account_guid: pkg.liability_account_guid },
                select: { tx_guid: true, value_num: true, value_denom: true },
            });
        for (const s of splits) {
            byTxn.set(s.tx_guid, (byTxn.get(s.tx_guid) ?? 0) + toDecimalNumber(s.value_num, s.value_denom));
        }
    }
    const price = Number(pkg.price);
    const perSession = pkg.sessions_total > 0 ? price / pkg.sessions_total : 0;
    const out = new Map<number, number>();
    for (const r of redemptions) {
        const fromTxn = r.txn_guid ? byTxn.get(r.txn_guid) : undefined;
        out.set(r.id, fromTxn !== undefined ? fromTxn : roundToFraction(perSession * r.sessions));
    }
    return out;
}

function buildView(
    pkg: PackageRow,
    redemptions: RedemptionRow[],
    amounts: Map<number, number>,
    clientNameFallback?: string | null,
): PackageDetailView {
    const price = Number(pkg.price);
    const redeemedSessions = redemptions.reduce((s, r) => s + r.sessions, 0);
    const redeemedValue = roundToFraction(
        redemptions.reduce((s, r) => s + (amounts.get(r.id) ?? 0), 0),
    );
    return {
        id: pkg.id,
        name: pkg.name,
        clientName: pkg.client_name ?? clientNameFallback ?? null,
        customerGuid: pkg.customer_guid ?? null,
        sessionsTotal: pkg.sessions_total,
        price,
        soldDate: isoDate(pkg.sold_date),
        redeemedSessions,
        remainingSessions: Math.max(0, pkg.sessions_total - redeemedSessions),
        redeemedValue,
        liabilityBalance: roundToFraction(price - redeemedValue),
        liabilityAccountGuid: pkg.liability_account_guid ?? null,
        incomeAccountGuid: pkg.income_account_guid ?? null,
        saleTxnGuid: pkg.sale_txn_guid ?? null,
        notes: pkg.notes ?? null,
        redemptions: redemptions
            .slice()
            .sort((a, b) => isoDate(a.redeemed_date).localeCompare(isoDate(b.redeemed_date)) || a.id - b.id)
            .map((r) => ({
                id: r.id,
                date: isoDate(r.redeemed_date),
                sessions: r.sessions,
                amount: amounts.get(r.id) ?? 0,
                txnGuid: r.txn_guid ?? null,
                notes: r.notes ?? null,
            })),
    };
}

// ---------------------------------------------------------------------------
// sellPackage
// ---------------------------------------------------------------------------

export async function sellPackage(bookGuid: string, input: SellPackageInput): Promise<PackageDetailView> {
    if (!input.name?.trim()) throw new PackageValidationError('Package name is required');
    if (!Number.isInteger(input.sessionsTotal) || input.sessionsTotal < 1) {
        throw new PackageValidationError('sessionsTotal must be a positive integer');
    }
    if (typeof input.price !== 'number' || !isFinite(input.price) || input.price <= 0) {
        throw new PackageValidationError('price must be a positive number');
    }
    if (!input.bankAccountGuid) throw new PackageValidationError('bankAccountGuid is required');
    const soldDate = parseIsoDateNoon(input.soldDate, 'soldDate');

    const bookAccountGuids = new Set(await getAccountGuidsForBook(bookGuid));
    if (bookAccountGuids.size === 0) throw new PackageNotFoundError(`Book not found: ${bookGuid}`);

    let packageId = 0;
    await prisma.$transaction(async (tx) => {
        const rootGuid = await getBookRootGuid(tx, bookGuid);

        const bank = await tx.accounts.findUnique({
            where: { guid: input.bankAccountGuid },
            select: { guid: true, account_type: true, commodity_guid: true, placeholder: true },
        });
        if (!bank || !bookAccountGuids.has(bank.guid)) {
            throw new PackageValidationError('Bank account not found in the active book');
        }
        if (bank.placeholder === 1) {
            throw new PackageValidationError('Bank account is a placeholder');
        }
        if (!bank.commodity_guid) {
            throw new PackageValidationError('Bank account has no commodity');
        }
        const currencyGuid = bank.commodity_guid;
        const fraction = await getCurrencyFraction(tx, currencyGuid);
        const price = roundToFraction(input.price, fraction);

        if (input.customerGuid) {
            const customer = await tx.customers.findUnique({
                where: { guid: input.customerGuid },
                select: { guid: true },
            });
            if (!customer) throw new PackageValidationError(`Customer not found: ${input.customerGuid}`);
        }

        // Liability account: explicit (validated) or auto-created with the
        // correct LIABILITY type (findOrCreateAccount would make it INCOME).
        let liabilityGuid = input.liabilityAccountGuid;
        if (liabilityGuid) {
            const liab = await tx.accounts.findUnique({
                where: { guid: liabilityGuid },
                select: { guid: true, account_type: true, placeholder: true },
            });
            if (!liab || !bookAccountGuids.has(liab.guid)) {
                throw new PackageValidationError('Liability account not found in the active book');
            }
            if (liab.account_type !== 'LIABILITY' && liab.account_type !== 'CREDIT') {
                throw new PackageValidationError('Liability account must be a LIABILITY account');
            }
            if (liab.placeholder === 1) throw new PackageValidationError('Liability account is a placeholder');
        } else {
            liabilityGuid = await ensureTypedAccount(tx, DEFAULT_LIABILITY_PATH, rootGuid, currencyGuid, 'LIABILITY');
        }

        const incomeGuid = input.incomeAccountGuid ?? null;
        if (incomeGuid) {
            const inc = await tx.accounts.findUnique({
                where: { guid: incomeGuid },
                select: { guid: true, account_type: true },
            });
            if (!inc || !bookAccountGuids.has(inc.guid)) {
                throw new PackageValidationError('Income account not found in the active book');
            }
            if (inc.account_type !== 'INCOME') {
                throw new PackageValidationError('Income account must be an INCOME account');
            }
        }

        const clientLabel = input.clientName?.trim() || '';
        const saleTxnGuid = await createTwoSplitTxn(tx, {
            currencyGuid,
            fraction,
            postDate: soldDate,
            description: `Package sale: ${input.name.trim()}${clientLabel ? ` — ${clientLabel}` : ''}`,
            debitAccountGuid: bank.guid,
            creditAccountGuid: liabilityGuid,
            amount: price,
        });

        const created = await tx.gnucash_web_packages.create({
            data: {
                book_guid: bookGuid,
                customer_guid: input.customerGuid ?? null,
                client_name: input.clientName?.trim() || null,
                name: input.name.trim(),
                sessions_total: input.sessionsTotal,
                price,
                sold_date: soldDate,
                liability_account_guid: liabilityGuid,
                income_account_guid: incomeGuid,
                sale_txn_guid: saleTxnGuid,
                notes: input.notes?.trim() || null,
            },
        });
        packageId = created.id;
    });

    return getPackage(bookGuid, packageId);
}

// ---------------------------------------------------------------------------
// redeemSession
// ---------------------------------------------------------------------------

export async function redeemSession(
    bookGuid: string,
    packageId: number,
    input: RedeemSessionInput = {},
): Promise<PackageDetailView> {
    const sessions = input.sessions ?? 1;
    if (!Number.isInteger(sessions) || sessions < 1) {
        throw new PackageValidationError('sessions must be a positive integer');
    }
    const date = input.date
        ? parseIsoDateNoon(input.date, 'date')
        : parseIsoDateNoon(new Date().toISOString().slice(0, 10), 'date');

    await prisma.$transaction(async (tx) => {
        const pkg = await tx.gnucash_web_packages.findUnique({ where: { id: packageId } });
        if (!pkg || pkg.book_guid !== bookGuid) {
            throw new PackageNotFoundError(`Package not found: ${packageId}`);
        }
        if (!pkg.liability_account_guid) {
            throw new PackageStateError('Package has no liability account — cannot redeem');
        }

        const redemptions = await tx.gnucash_web_package_redemptions.findMany({
            where: { package_id: packageId },
        });
        const redeemedBefore = redemptions.reduce((s, r) => s + r.sessions, 0);
        const remaining = pkg.sessions_total - redeemedBefore;
        if (sessions > remaining) {
            throw new PackageStateError(
                `Cannot redeem ${sessions} session(s): only ${remaining} remaining`,
            );
        }

        // Income account: from the package, or auto-created on first use.
        let incomeGuid = pkg.income_account_guid;
        if (!incomeGuid) {
            const rootGuid = await getBookRootGuid(tx, bookGuid);
            const liab = await tx.accounts.findUnique({
                where: { guid: pkg.liability_account_guid },
                select: { commodity_guid: true },
            });
            incomeGuid = await ensureTypedAccount(
                tx,
                DEFAULT_INCOME_PATH,
                rootGuid,
                liab?.commodity_guid ?? '',
                'INCOME',
            );
            await tx.gnucash_web_packages.update({
                where: { id: packageId },
                data: { income_account_guid: incomeGuid },
            });
        }

        const liabAccount = await tx.accounts.findUnique({
            where: { guid: pkg.liability_account_guid },
            select: { commodity_guid: true },
        });
        if (!liabAccount?.commodity_guid) {
            throw new PackageStateError('Liability account is missing a commodity');
        }
        const currencyGuid = liabAccount.commodity_guid;
        const fraction = await getCurrencyFraction(tx, currencyGuid);

        const amounts = await redemptionAmounts(tx, pkg, redemptions);
        const priorAmounts = redemptions.map((r) => amounts.get(r.id) ?? 0);
        const amount = computeRedemptionAmount(
            Number(pkg.price),
            pkg.sessions_total,
            sessions,
            redeemedBefore,
            priorAmounts,
            fraction,
        );

        const txnGuid = await createTwoSplitTxn(tx, {
            currencyGuid,
            fraction,
            postDate: date,
            description: `Package redemption: ${pkg.name} (${sessions} session${sessions === 1 ? '' : 's'})`,
            debitAccountGuid: pkg.liability_account_guid,
            creditAccountGuid: incomeGuid,
            amount,
            memo: input.notes?.trim() || '',
        });

        await tx.gnucash_web_package_redemptions.create({
            data: {
                package_id: packageId,
                redeemed_date: date,
                sessions,
                txn_guid: txnGuid,
                notes: input.notes?.trim() || null,
            },
        });
    });

    return getPackage(bookGuid, packageId);
}

// ---------------------------------------------------------------------------
// deleteRedemption / updatePackage / deletePackage
// ---------------------------------------------------------------------------

export async function deleteRedemption(bookGuid: string, redemptionId: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const redemption = await tx.gnucash_web_package_redemptions.findUnique({
            where: { id: redemptionId },
            include: { package: true },
        });
        if (!redemption || redemption.package.book_guid !== bookGuid) {
            throw new PackageNotFoundError(`Redemption not found: ${redemptionId}`);
        }
        if (redemption.txn_guid) {
            await deleteTxn(tx, redemption.txn_guid);
        }
        await tx.gnucash_web_package_redemptions.delete({ where: { id: redemptionId } });
    });
}

export async function updatePackage(
    bookGuid: string,
    packageId: number,
    input: UpdatePackageInput,
): Promise<PackageDetailView> {
    if (input.name !== undefined && !input.name?.trim()) {
        throw new PackageValidationError('Package name cannot be empty');
    }
    await prisma.$transaction(async (tx) => {
        const pkg = await tx.gnucash_web_packages.findUnique({ where: { id: packageId } });
        if (!pkg || pkg.book_guid !== bookGuid) {
            throw new PackageNotFoundError(`Package not found: ${packageId}`);
        }
        if (input.customerGuid) {
            const customer = await tx.customers.findUnique({
                where: { guid: input.customerGuid },
                select: { guid: true },
            });
            if (!customer) throw new PackageValidationError(`Customer not found: ${input.customerGuid}`);
        }
        await tx.gnucash_web_packages.update({
            where: { id: packageId },
            data: {
                name: input.name !== undefined ? input.name.trim() : undefined,
                client_name: input.clientName !== undefined ? input.clientName?.trim() || null : undefined,
                customer_guid: input.customerGuid !== undefined ? input.customerGuid || null : undefined,
                notes: input.notes !== undefined ? input.notes?.trim() || null : undefined,
                updated_at: new Date(),
            },
        });
    });
    return getPackage(bookGuid, packageId);
}

/**
 * Void a package: deletes the redemption transactions, the sale transaction,
 * and the package row (redemption rows cascade).
 */
export async function deletePackage(bookGuid: string, packageId: number): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const pkg = await tx.gnucash_web_packages.findUnique({
            where: { id: packageId },
            include: { redemptions: true },
        });
        if (!pkg || pkg.book_guid !== bookGuid) {
            throw new PackageNotFoundError(`Package not found: ${packageId}`);
        }
        for (const r of pkg.redemptions) {
            if (r.txn_guid) await deleteTxn(tx, r.txn_guid);
        }
        if (pkg.sale_txn_guid) await deleteTxn(tx, pkg.sale_txn_guid);
        await tx.gnucash_web_packages.delete({ where: { id: packageId } });
    });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPackage(bookGuid: string, packageId: number): Promise<PackageDetailView> {
    const pkg = await prisma.gnucash_web_packages.findUnique({
        where: { id: packageId },
        include: { redemptions: true },
    });
    if (!pkg || pkg.book_guid !== bookGuid) {
        throw new PackageNotFoundError(`Package not found: ${packageId}`);
    }
    const amounts = await redemptionAmounts(prisma as unknown as PrismaTx, pkg, pkg.redemptions);

    let customerName: string | null = null;
    if (pkg.customer_guid) {
        const customer = await prisma.customers.findUnique({
            where: { guid: pkg.customer_guid },
            select: { name: true },
        });
        customerName = customer?.name ?? null;
    }
    return buildView(pkg, pkg.redemptions, amounts, customerName);
}

export async function listPackages(bookGuid: string): Promise<PackageDetailView[]> {
    const packages = await prisma.gnucash_web_packages.findMany({
        where: { book_guid: bookGuid },
        include: { redemptions: true },
        orderBy: [{ sold_date: 'desc' }, { id: 'desc' }],
    });

    const customerGuids = Array.from(
        new Set(packages.map((p) => p.customer_guid).filter((g): g is string => Boolean(g))),
    );
    const customers = customerGuids.length
        ? await prisma.customers.findMany({
              where: { guid: { in: customerGuids } },
              select: { guid: true, name: true },
          })
        : [];
    const customerNames = new Map(customers.map((c) => [c.guid, c.name]));

    const views: PackageDetailView[] = [];
    for (const pkg of packages) {
        const amounts = await redemptionAmounts(prisma as unknown as PrismaTx, pkg, pkg.redemptions);
        views.push(
            buildView(pkg, pkg.redemptions, amounts, pkg.customer_guid ? customerNames.get(pkg.customer_guid) : null),
        );
    }
    return views;
}
