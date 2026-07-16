/**
 * Inbound Webhook Payload Schemas (pure)
 *
 * Validation for the convenience endpoints under /api/webhooks/inbound/*,
 * designed for automation tools (n8n, Home Assistant, shell scripts) that
 * want to push events into GnuCash Web with a minimal JSON body instead of
 * the full GnuCash split model.
 *
 * Authentication happens in the routes via the same Bearer `gcw_...`
 * personal-access-token path every API endpoint uses (requireRole('edit')).
 * This module is pure — schemas only — so route validation is unit-testable
 * without any HTTP or database mocking.
 */

import { z } from 'zod';
import { PAYMENT_METHODS, type PaymentMethod } from '@/lib/membership';

const isoDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
    .refine(s => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()), 'must be a valid date');

const guidSchema = z
    .string()
    .regex(/^[0-9a-f]{32}$/i, 'must be a 32-character hex GUID');

/**
 * POST /api/webhooks/inbound/transaction
 * A simple two-split transfer: `amount` moves FROM `fromAccountGuid` TO
 * `toAccountGuid` (from is credited, to is debited). Both accounts must be
 * plain currency accounts in the token's book.
 */
export const inboundTransactionSchema = z
    .object({
        date: isoDateSchema,
        description: z.string().trim().min(1, 'description is required').max(2048),
        amount: z
            .number()
            .finite()
            .positive('amount must be a positive number')
            .max(1_000_000_000, 'amount is implausibly large'),
        fromAccountGuid: guidSchema,
        toAccountGuid: guidSchema,
    })
    .refine(v => v.fromAccountGuid.toLowerCase() !== v.toAccountGuid.toLowerCase(), {
        message: 'fromAccountGuid and toAccountGuid must differ',
        path: ['toAccountGuid'],
    });

export type InboundTransactionInput = z.infer<typeof inboundTransactionSchema>;

/**
 * POST /api/webhooks/inbound/membership-payment
 * Records a dues payment against an existing member via the membership
 * service (coverage period is derived from the member's membership type).
 */
export const inboundMembershipPaymentSchema = z.object({
    memberId: z.number().int().positive('memberId must be a positive integer'),
    amount: z.number().finite().min(0).nullish(),
    paidDate: isoDateSchema,
    method: z.enum(PAYMENT_METHODS as unknown as [PaymentMethod, ...PaymentMethod[]]).default('other'),
    reference: z.string().trim().max(100).nullish(),
});

export type InboundMembershipPaymentInput = z.infer<typeof inboundMembershipPaymentSchema>;

export interface InboundValidationOk<T> {
    ok: true;
    data: T;
}
export interface InboundValidationErr {
    ok: false;
    /** Human-readable message for the first failing field. */
    error: string;
}

/** safeParse wrapper returning a route-friendly result. */
export function parseInbound<S extends z.ZodType>(
    schema: S,
    body: unknown
): InboundValidationOk<z.infer<S>> | InboundValidationErr {
    const result = schema.safeParse(body);
    if (result.success) return { ok: true, data: result.data };
    const first = result.error.issues[0];
    const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    return { ok: false, error: `${path}${first.message}` };
}

/** Integer cents for a validated inbound amount (avoids FP drift). */
export function toCents(amount: number): number {
    return Math.round(amount * 100);
}
