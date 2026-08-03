// POST /api/webhooks/inbound/transaction
//
// Convenience endpoint for automation tools (n8n, scripts): create a simple
// two-split transaction from a minimal JSON body instead of the full GnuCash
// split model. Authenticated exactly like every other endpoint — a Bearer
// `gcw_...` personal access token (or a browser session) with the edit role;
// the transaction lands in the token's book.
//
// Body: { date, description, amount, fromAccountGuid, toAccountGuid,
//         idempotencyKey? }
// `amount` (positive, in book currency) moves FROM `fromAccountGuid`
// (credited) TO `toAccountGuid` (debited). Both accounts must be currency
// accounts denominated in the transaction currency.
//
// Idempotency: pass an `Idempotency-Key` header or an `idempotencyKey` body
// field. The key is claimed against a UNIQUE index before the write, so an
// n8n retry after a timeout is rejected by the database (and gets the
// original response back) instead of posting a second ledger entry.

import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { generateGuid } from '@/lib/gnucash';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { withPeriodLockCheck } from '@/lib/services/period-lock.service';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import { logAudit } from '@/lib/services/audit.service';
import { inboundTransactionSchema, parseInbound, toCents } from '@/lib/inbound-webhooks';
import {
    claimWebhookIdempotency,
    completeWebhookIdempotency,
    readIdempotencyKey,
    releaseWebhookIdempotency,
    validateIdempotencyKey,
} from '@/lib/webhook-idempotency';

export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid } = roleResult;

        const body = await request.json().catch(() => null);
        const parsed = parseInbound(inboundTransactionSchema, body);
        if (!parsed.ok) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }
        const input = parsed.data;

        const keyCheck = validateIdempotencyKey(
            readIdempotencyKey(request.headers.get('idempotency-key'), body)
        );
        if (!keyCheck.ok) {
            return NextResponse.json({ error: keyCheck.error }, { status: 400 });
        }
        const idempotencyKey = keyCheck.key;

        // Period lock: reject postings into a closed period.
        const lockError = await withPeriodLockCheck(bookGuid, [input.date]);
        if (lockError) return lockError;

        // Both accounts must belong to the token's book.
        const bookAccountGuids = new Set(await getAccountGuidsForBook(bookGuid));
        const fromGuid = input.fromAccountGuid.toLowerCase();
        const toGuid = input.toAccountGuid.toLowerCase();
        for (const guid of [fromGuid, toGuid]) {
            if (!bookAccountGuids.has(guid)) {
                return NextResponse.json(
                    { error: `Account ${guid} not found in this book` },
                    { status: 400 }
                );
            }
        }

        // Transaction currency = the book root's commodity. Both accounts
        // must be denominated in it (this endpoint is for simple money
        // movement, not stock trades or multi-currency transfers).
        const book = await prisma.books.findUnique({
            where: { guid: bookGuid },
            select: { root_account_guid: true },
        });
        if (!book) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }
        const [root, accounts] = await Promise.all([
            prisma.accounts.findUnique({
                where: { guid: book.root_account_guid },
                select: { commodity_guid: true },
            }),
            prisma.accounts.findMany({
                where: { guid: { in: [fromGuid, toGuid] } },
                select: { guid: true, name: true, commodity_guid: true, commodity_scu: true, placeholder: true },
            }),
        ]);
        if (!root?.commodity_guid) {
            return NextResponse.json({ error: 'Book has no base currency' }, { status: 500 });
        }
        for (const account of accounts) {
            if (account.placeholder === 1) {
                return NextResponse.json(
                    { error: `Account "${account.name}" is a placeholder and cannot hold transactions` },
                    { status: 400 }
                );
            }
            if (account.commodity_guid !== root.commodity_guid) {
                return NextResponse.json(
                    { error: `Account "${account.name}" is not denominated in the book currency; use POST /api/transactions for multi-commodity entries` },
                    { status: 400 }
                );
            }
        }

        // Claim the idempotency key BEFORE the write. The UNIQUE index picks
        // the winner, so a concurrent replay can never also reach the insert.
        if (idempotencyKey) {
            const claim = await claimWebhookIdempotency(bookGuid, 'transaction', idempotencyKey);
            if (claim.status === 'replay') {
                if (claim.result) {
                    return NextResponse.json(
                        { ...(claim.result as Record<string, unknown>), replayed: true },
                        { status: 200 }
                    );
                }
                return NextResponse.json(
                    { error: 'A request with this idempotencyKey is already in progress' },
                    { status: 409 }
                );
            }
        }

        const cents = toCents(input.amount);
        const txGuid = generateGuid();
        const now = new Date();
        const postDate = new Date(`${input.date}T12:00:00Z`);

        try {
            await prisma.$transaction([
            prisma.transactions.create({
                data: {
                    guid: txGuid,
                    currency_guid: root.commodity_guid,
                    num: '',
                    post_date: postDate,
                    enter_date: now,
                    description: input.description,
                },
            }),
            prisma.splits.createMany({
                data: [
                    {
                        guid: generateGuid(),
                        tx_guid: txGuid,
                        account_guid: toGuid,
                        memo: '',
                        action: '',
                        reconcile_state: 'n',
                        reconcile_date: null,
                        value_num: BigInt(cents),
                        value_denom: 100n,
                        quantity_num: BigInt(cents),
                        quantity_denom: 100n,
                        lot_guid: null,
                    },
                    {
                        guid: generateGuid(),
                        tx_guid: txGuid,
                        account_guid: fromGuid,
                        memo: '',
                        action: '',
                        reconcile_state: 'n',
                        reconcile_date: null,
                        value_num: BigInt(-cents),
                        value_denom: 100n,
                        quantity_num: BigInt(-cents),
                        quantity_denom: 100n,
                        lot_guid: null,
                    },
                ],
            }),
            ]);
        } catch (writeError) {
            // The write failed, so the key must not stay burned — a genuine
            // retry has to be able to proceed.
            if (idempotencyKey) {
                await releaseWebhookIdempotency(bookGuid, 'transaction', idempotencyKey);
            }
            throw writeError;
        }

        // Best-effort audit trail + cache invalidation (non-fatal).
        await logAudit('CREATE', 'TRANSACTION', txGuid, null, {
            source: 'inbound_webhook',
            description: input.description,
            post_date: input.date,
            amount: input.amount,
            from_account_guid: fromGuid,
            to_account_guid: toGuid,
        });
        try {
            await cacheInvalidateFrom(bookGuid, postDate);
        } catch (err) {
            console.warn('Inbound webhook: cache invalidation failed:', err);
        }
        void publishDataChange(bookGuid, 'transactions', { guid: txGuid, action: 'create' });

        const payload = {
            success: true,
            transactionGuid: txGuid,
            date: input.date,
            description: input.description,
            amount: input.amount,
        };
        if (idempotencyKey) {
            await completeWebhookIdempotency(bookGuid, 'transaction', idempotencyKey, payload);
        }

        return NextResponse.json(payload, { status: 201 });
    } catch (error) {
        console.error('Error in inbound transaction webhook:', error);
        return NextResponse.json({ error: 'Failed to create transaction' }, { status: 500 });
    }
}
