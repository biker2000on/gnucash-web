import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { withPeriodLockCheck } from '@/lib/services/period-lock.service';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { isValidGuid } from '@/lib/guid';
import { logAudit } from '@/lib/services/audit.service';
import { cacheInvalidateFrom } from '@/lib/cache';
import {
    postEsppPurchase,
    validateEsppInput,
    EquityCompValidationError,
    type PostEsppInput,
} from '@/lib/equity-comp';

/**
 * @openapi
 * /api/equity-comp/espp:
 *   post:
 *     description: >
 *       Record an ESPP purchase. Shares enter the stock account at basis =
 *       FMV (not the discounted purchase price); the discount is credited as
 *       compensation income and cash is reduced by only the actual cost.
 *     responses:
 *       201:
 *         description: ESPP transaction created.
 *       400:
 *         description: Validation error.
 *       403:
 *         description: Insufficient role.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json() as Partial<PostEsppInput>;

        const errors: string[] = [];
        const guidFields: Array<[string, string | undefined]> = [
            ['stockAccountGuid', body.stockAccountGuid],
            ['cashAccountGuid', body.cashAccountGuid],
            ['incomeAccountGuid', body.incomeAccountGuid],
        ];
        for (const [field, value] of guidFields) {
            if (!value) {
                errors.push(`${field} is required`);
            } else if (!isValidGuid(value)) {
                errors.push(`${field} is not a valid GUID`);
            }
        }
        if (!body.purchaseDate || typeof body.purchaseDate !== 'string') {
            errors.push('purchaseDate is required (YYYY-MM-DD)');
        }

        // Numeric validation via the shared pure-core validator.
        errors.push(...validateEsppInput({
            shares: body.shares as number,
            fmvPerShare: body.fmvPerShare as number,
            purchasePricePerShare: body.purchasePricePerShare as number,
            discountPercent: body.discountPercent,
        }));

        if (errors.length > 0) {
            return NextResponse.json({ errors }, { status: 400 });
        }

        // Book-scope validation: every referenced account must belong to the
        // active book.
        const bookAccountGuids = new Set(await getBookAccountGuids());
        const referenced = guidFields
            .map(([, value]) => value)
            .filter((v): v is string => !!v);
        const outOfBook = referenced.filter(guid => !bookAccountGuids.has(guid));
        if (outOfBook.length > 0) {
            return NextResponse.json(
                { errors: [`Accounts not in the active book: ${outOfBook.join(', ')}`] },
                { status: 400 },
            );
        }

        // Period lock: the ESPP purchase transaction is dated purchaseDate
        const lockError = await withPeriodLockCheck(roleResult.bookGuid, [body.purchaseDate as string]);
        if (lockError) return lockError;

        const result = await prisma.$transaction(async (tx) =>
            postEsppPurchase(body as PostEsppInput, tx)
        );

        await logAudit('CREATE', 'TRANSACTION', result.txGuid, null, {
            source: 'equity-comp',
            kind: 'espp',
            description: result.description,
            post_date: result.postDate,
            splits_count: result.splitCount,
            trading_splits_added: result.tradingSplitsAdded,
            compensation_income: result.compensationIncome,
        });

        try {
            const bookGuid = await getActiveBookGuid();
            await cacheInvalidateFrom(bookGuid, new Date(result.postDate));
        } catch (err) {
            console.warn('Cache invalidation failed:', err);
        }

        return NextResponse.json(result, { status: 201 });
    } catch (error) {
        if (error instanceof EquityCompValidationError) {
            return NextResponse.json({ errors: error.errors }, { status: 400 });
        }
        console.error('Error posting ESPP purchase:', error);
        return NextResponse.json({ error: 'Failed to post ESPP purchase' }, { status: 500 });
    }
}
