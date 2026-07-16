import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { withPeriodLockCheck } from '@/lib/services/period-lock.service';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { isValidGuid } from '@/lib/guid';
import { logAudit } from '@/lib/services/audit.service';
import { cacheInvalidateFrom } from '@/lib/cache';
import {
    postVestEvent,
    validateVestInput,
    EquityCompValidationError,
    type PostVestInput,
} from '@/lib/equity-comp';

/**
 * @openapi
 * /api/equity-comp/vest:
 *   post:
 *     description: >
 *       Record an RSU vest event. Net shares (gross minus sell-to-cover
 *       withholding) enter the stock account at FMV cost basis, gross vest
 *       value is credited to compensation income, and the withheld-share
 *       value is debited to the tax/withholding account.
 *     responses:
 *       201:
 *         description: Vest transaction created.
 *       400:
 *         description: Validation error.
 *       403:
 *         description: Insufficient role.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body = await request.json() as Partial<PostVestInput>;

        const errors: string[] = [];
        const guidFields: Array<[string, string | undefined, boolean]> = [
            ['stockAccountGuid', body.stockAccountGuid, true],
            ['incomeAccountGuid', body.incomeAccountGuid, true],
            ['taxExpenseOrWithholdingAccountGuid', body.taxExpenseOrWithholdingAccountGuid, true],
            ['cashAccountGuid', body.cashAccountGuid, false],
        ];
        for (const [field, value, required] of guidFields) {
            if (!value) {
                if (required) errors.push(`${field} is required`);
            } else if (!isValidGuid(value)) {
                errors.push(`${field} is not a valid GUID`);
            }
        }
        if (!body.vestDate || typeof body.vestDate !== 'string') {
            errors.push('vestDate is required (YYYY-MM-DD)');
        }

        // Numeric validation via the shared pure-core validator.
        errors.push(...validateVestInput({
            sharesVested: body.sharesVested as number,
            fmvPerShare: body.fmvPerShare as number,
            sharesWithheldForTax: body.sharesWithheldForTax,
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

        // Period lock: the vest transaction is dated vestDate
        const lockError = await withPeriodLockCheck(roleResult.bookGuid, [body.vestDate as string]);
        if (lockError) return lockError;

        const result = await prisma.$transaction(async (tx) =>
            postVestEvent(body as PostVestInput, tx)
        );

        await logAudit('CREATE', 'TRANSACTION', result.txGuid, null, {
            source: 'equity-comp',
            kind: 'vest',
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
        console.error('Error posting vest event:', error);
        return NextResponse.json({ error: 'Failed to post vest event' }, { status: 500 });
    }
}
