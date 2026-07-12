/**
 * Equity Compensation — Vest-Event / ESPP Posting Engine
 *
 * Creates balanced GnuCash transactions for:
 *   - RSU vest events (with optional sell-to-cover tax withholding)
 *   - ESPP purchases (discount recognized as compensation income)
 *
 * Cost-basis rule (the critical anti-double-taxation detail): shares always
 * enter the stock account at basis = FMV on the vest/purchase date, because
 * the FMV value (RSU) or discount (ESPP) is already taxed as W-2 income.
 *
 * Lot handling: stock splits are created with lot_guid = NULL, exactly like
 * buys created through POST /api/transactions. The existing lot auto-assign /
 * scrub engine (`lot-assignment.ts`) picks up unassigned positive-quantity
 * splits and opens lots for them, so no lot logic is duplicated here.
 *
 * Trading accounts: reuses `processMultiCurrencySplits()` from
 * `trading-accounts.ts` — the same mechanism POST /api/transactions applies —
 * so books that carry trading accounts get identical Trading:* splits.
 *
 * Every posted transaction is tagged with a slot
 * (name = 'gnucash_web_equity_comp', string_val = 'vest' | 'espp') so the UI
 * can list equity-comp history without heuristics.
 */

import prisma, { generateGuid } from './prisma';
import { processMultiCurrencySplits } from './trading-accounts';
import {
    computeVestSplits,
    computeEsppSplits,
    EquityCompValidationError,
    DEFAULT_SHARE_FRACTION,
    DEFAULT_CURRENCY_FRACTION,
    type EquityCompRole,
    type EquityCompSplitSpec,
} from './equity-comp-core';

// Re-export the pure core so consumers can import everything from one place.
export * from './equity-comp-core';

/** Slot name used to tag equity-comp transactions. */
export const EQUITY_COMP_SLOT = 'gnucash_web_equity_comp';
export type EquityCompKind = 'vest' | 'espp';

/** Prisma interactive transaction client type. */
export type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface PostVestInput {
    stockAccountGuid: string;
    /** ISO date (YYYY-MM-DD) of the vest. */
    vestDate: string;
    /** Gross shares vesting. */
    sharesVested: number;
    /** Fair market value per share at vest. */
    fmvPerShare: number;
    /** Shares withheld (sell-to-cover). Default 0. */
    sharesWithheldForTax?: number;
    /** W-2 compensation income account (credited for gross vest value). */
    incomeAccountGuid: string;
    /** Tax withholding / expense account (debited with withheld-share value). */
    taxExpenseOrWithholdingAccountGuid: string;
    /**
     * Reserved for future use (e.g. residual cash from fractional-share
     * sell-to-cover). Accepted and validated but no split is generated —
     * a standard sell-to-cover vest needs no cash leg.
     */
    cashAccountGuid?: string;
    description?: string;
}

export interface PostEsppInput {
    stockAccountGuid: string;
    /** ISO date (YYYY-MM-DD) of the purchase. */
    purchaseDate: string;
    shares: number;
    /** Fair market value per share on the purchase date. */
    fmvPerShare: number;
    /** Informational; purchasePricePerShare is authoritative. */
    discountPercent?: number;
    /** Actual discounted price paid per share (fmv × (1 − discount) or custom). */
    purchasePricePerShare: number;
    /** Account cash is drawn from (payroll deduction clearing, brokerage cash, …). */
    cashAccountGuid: string;
    /** Compensation income account credited with the discount. */
    incomeAccountGuid: string;
    description?: string;
}

export interface PostEquityCompResult {
    txGuid: string;
    kind: EquityCompKind;
    description: string;
    postDate: string;
    /** Number of splits written, including any trading splits. */
    splitCount: number;
    /** Trading splits added by processMultiCurrencySplits. */
    tradingSplitsAdded: number;
    /** Gross compensation income recognized (positive number). */
    compensationIncome: number;
    /** Shares landing in the stock account. */
    sharesAcquired: number;
    /** Cost basis established for the acquired shares (= FMV value). */
    costBasis: number;
}

interface AccountWithCommodity {
    guid: string;
    name: string;
    account_type: string;
    commodity_guid: string | null;
    commodity: {
        guid: string;
        mnemonic: string;
        namespace: string;
        fraction: number;
    } | null;
}

async function loadAccount(guid: string, label: string, tx: PrismaTx): Promise<AccountWithCommodity> {
    const account = await tx.accounts.findUnique({
        where: { guid },
        select: {
            guid: true,
            name: true,
            account_type: true,
            commodity_guid: true,
            commodity: {
                select: { guid: true, mnemonic: true, namespace: true, fraction: true },
            },
        },
    });
    if (!account) {
        throw new EquityCompValidationError([`${label} account not found: ${guid}`]);
    }
    return account;
}

/** Pick the transaction currency: first currency-denominated account wins. */
function pickCurrencyGuid(candidates: AccountWithCommodity[]): string {
    for (const account of candidates) {
        if (account.commodity && account.commodity.namespace === 'CURRENCY') {
            return account.commodity.guid;
        }
    }
    throw new EquityCompValidationError([
        'Could not determine transaction currency: none of the income/tax/cash accounts is denominated in a currency',
    ]);
}

function parsePostDate(dateStr: string, label: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        throw new EquityCompValidationError([`${label} must be an ISO date (YYYY-MM-DD)`]);
    }
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
        throw new EquityCompValidationError([`${label} is not a valid date`]);
    }
    return date;
}

/**
 * Write the transaction, its splits (with trading splits when the commodities
 * differ), and the equity-comp tag slot. Shared by vest and ESPP posting.
 */
async function writeTransaction(
    params: {
        kind: EquityCompKind;
        postDate: Date;
        description: string;
        currencyGuid: string;
        specs: EquityCompSplitSpec[];
        roleAccounts: Partial<Record<EquityCompRole, string>>;
    },
    tx: PrismaTx,
): Promise<{ txGuid: string; splitCount: number; tradingSplitsAdded: number }> {
    const { kind, postDate, description, currencyGuid, specs, roleAccounts } = params;

    const rawSplits = specs.map(spec => {
        const accountGuid = roleAccounts[spec.role];
        if (!accountGuid) {
            throw new EquityCompValidationError([`No account provided for split role "${spec.role}"`]);
        }
        return {
            account_guid: accountGuid,
            value_num: spec.valueNum,
            value_denom: spec.valueDenom,
            quantity_num: spec.quantityNum,
            quantity_denom: spec.quantityDenom,
            memo: spec.memo,
            action: spec.action,
            reconcile_state: 'n' as const,
        };
    });

    // Same trading-account handling as POST /api/transactions: when splits
    // span multiple commodities (stock + currency), balancing Trading:* splits
    // are generated, matching how this book's other investment transactions
    // are recorded.
    const { allSplits } = await processMultiCurrencySplits(rawSplits, tx);

    const txGuid = generateGuid();
    await tx.transactions.create({
        data: {
            guid: txGuid,
            currency_guid: currencyGuid,
            num: '',
            post_date: postDate,
            enter_date: new Date(),
            description,
        },
    });

    for (const split of allSplits) {
        await tx.splits.create({
            data: {
                guid: generateGuid(),
                tx_guid: txGuid,
                account_guid: split.account_guid,
                memo: split.memo || '',
                action: split.action || '',
                reconcile_state: split.reconcile_state || 'n',
                reconcile_date: null,
                value_num: BigInt(split.value_num),
                value_denom: BigInt(split.value_denom),
                quantity_num: BigInt(split.quantity_num),
                quantity_denom: BigInt(split.quantity_denom),
                // Lot-less on purpose: the existing lot auto-assign / scrub
                // engine opens lots for unassigned acquisition splits.
                lot_guid: null,
            },
        });
    }

    // Tag the transaction so the UI can list equity-comp history.
    await tx.slots.create({
        data: {
            obj_guid: txGuid,
            name: EQUITY_COMP_SLOT,
            slot_type: 4, // string slot
            string_val: kind,
        },
    });

    return {
        txGuid,
        splitCount: allSplits.length,
        tradingSplitsAdded: allSplits.length - rawSplits.length,
    };
}

/**
 * Post an RSU vest event.
 *
 * Creates a balanced transaction where:
 *   - net shares (gross − withheld) land in the stock account at FMV basis
 *   - gross vest value is credited to compensation income (negative)
 *   - withheld-share value is debited to the tax/withholding account
 *
 * Must be called inside `prisma.$transaction`.
 */
export async function postVestEvent(
    input: PostVestInput,
    tx: PrismaTx,
): Promise<PostEquityCompResult> {
    const stock = await loadAccount(input.stockAccountGuid, 'Stock', tx);
    const income = await loadAccount(input.incomeAccountGuid, 'Income', tx);
    const taxAccount = await loadAccount(
        input.taxExpenseOrWithholdingAccountGuid, 'Tax/withholding', tx,
    );
    const cash = input.cashAccountGuid
        ? await loadAccount(input.cashAccountGuid, 'Cash', tx)
        : null;

    const postDate = parsePostDate(input.vestDate, 'vestDate');
    const currencyGuid = pickCurrencyGuid([income, taxAccount, ...(cash ? [cash] : [])]);
    const shareFraction = stock.commodity?.fraction ?? DEFAULT_SHARE_FRACTION;
    const symbol = stock.commodity?.mnemonic;

    const specs = computeVestSplits({
        sharesVested: input.sharesVested,
        fmvPerShare: input.fmvPerShare,
        sharesWithheldForTax: input.sharesWithheldForTax,
        shareFraction: shareFraction > 0 ? shareFraction : DEFAULT_SHARE_FRACTION,
        currencyFraction: DEFAULT_CURRENCY_FRACTION,
        symbol,
    });

    const withheld = input.sharesWithheldForTax ?? 0;
    const netShares = input.sharesVested - withheld;
    const description = input.description?.trim()
        || `RSU Vest: ${input.sharesVested} ${symbol ?? stock.name} @ ${input.fmvPerShare}`
            + (withheld > 0 ? ` (${withheld} withheld for tax)` : '');

    const written = await writeTransaction({
        kind: 'vest',
        postDate,
        description,
        currencyGuid,
        specs,
        roleAccounts: {
            stock: stock.guid,
            income: income.guid,
            tax: taxAccount.guid,
        },
    }, tx);

    const incomeSpec = specs.find(s => s.role === 'income')!;
    const stockSpec = specs.find(s => s.role === 'stock')!;

    return {
        txGuid: written.txGuid,
        kind: 'vest',
        description,
        postDate: input.vestDate,
        splitCount: written.splitCount,
        tradingSplitsAdded: written.tradingSplitsAdded,
        compensationIncome: -incomeSpec.valueNum / incomeSpec.valueDenom,
        sharesAcquired: netShares,
        costBasis: stockSpec.valueNum / stockSpec.valueDenom,
    };
}

/**
 * Post an ESPP purchase.
 *
 * Creates a balanced transaction where:
 *   - shares land in the stock account at basis = FMV (not the discounted price)
 *   - cash is reduced by only the actual purchase cost
 *   - the discount ((FMV − price) × shares) is credited as compensation income
 *
 * Must be called inside `prisma.$transaction`.
 */
export async function postEsppPurchase(
    input: PostEsppInput,
    tx: PrismaTx,
): Promise<PostEquityCompResult> {
    const stock = await loadAccount(input.stockAccountGuid, 'Stock', tx);
    const cash = await loadAccount(input.cashAccountGuid, 'Cash', tx);
    const income = await loadAccount(input.incomeAccountGuid, 'Income', tx);

    const postDate = parsePostDate(input.purchaseDate, 'purchaseDate');
    const currencyGuid = pickCurrencyGuid([cash, income]);
    const shareFraction = stock.commodity?.fraction ?? DEFAULT_SHARE_FRACTION;
    const symbol = stock.commodity?.mnemonic;

    const specs = computeEsppSplits({
        shares: input.shares,
        fmvPerShare: input.fmvPerShare,
        purchasePricePerShare: input.purchasePricePerShare,
        discountPercent: input.discountPercent,
        shareFraction: shareFraction > 0 ? shareFraction : DEFAULT_SHARE_FRACTION,
        currencyFraction: DEFAULT_CURRENCY_FRACTION,
        symbol,
    });

    const description = input.description?.trim()
        || `ESPP Purchase: ${input.shares} ${symbol ?? stock.name} @ ${input.purchasePricePerShare}`
            + ` (FMV ${input.fmvPerShare})`;

    const written = await writeTransaction({
        kind: 'espp',
        postDate,
        description,
        currencyGuid,
        specs,
        roleAccounts: {
            stock: stock.guid,
            cash: cash.guid,
            income: income.guid,
        },
    }, tx);

    const incomeSpec = specs.find(s => s.role === 'income');
    const stockSpec = specs.find(s => s.role === 'stock')!;

    return {
        txGuid: written.txGuid,
        kind: 'espp',
        description,
        postDate: input.purchaseDate,
        splitCount: written.splitCount,
        tradingSplitsAdded: written.tradingSplitsAdded,
        compensationIncome: incomeSpec ? -incomeSpec.valueNum / incomeSpec.valueDenom : 0,
        sharesAcquired: input.shares,
        costBasis: stockSpec.valueNum / stockSpec.valueDenom,
    };
}
