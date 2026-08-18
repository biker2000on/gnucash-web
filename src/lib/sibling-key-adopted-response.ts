/**
 * The HTTP shape of a {@link SiblingKeyAdoptedError} that outlived its retries.
 *
 * `withAdoptionRetry` re-runs an attempt up to three times, and each retry
 * needs a DIFFERENT concurrent transaction to have committed inside a window
 * measured in milliseconds — so exhausting the budget is close to unheard of.
 * Close to is not never, and when it happens the error is still purely
 * transient: some other request created the account this one was about to
 * create, and running the same request again resolves it.
 *
 * Left unmapped it reaches the generic `catch` in a route handler and is
 * reported as a 500, which tells the user their data is broken when in fact
 * nothing is wrong and the right move is to press the button again. 503 with
 * `Retry-After` says exactly that, and says it to programmatic clients too.
 *
 * 409 would be the wrong code even though the cause is a conflict: the other
 * 409s these mappers return (duplicate SKU, unposted invoice) are permanent
 * states that a client must not retry into.
 */
import { NextResponse } from 'next/server';
import { SiblingKeyAdoptedError } from '@/lib/book-lock';

/** Seconds a client should wait before retrying. The contention is sub-second. */
const RETRY_AFTER_SECONDS = 1;

/** True when `error` is an exhausted adoption retry. */
export function isSiblingKeyAdopted(error: unknown): error is SiblingKeyAdoptedError {
    return error instanceof SiblingKeyAdoptedError;
}

/** The 503 for an exhausted adoption retry. */
export function siblingKeyAdoptedResponse(error: SiblingKeyAdoptedError): NextResponse {
    return NextResponse.json(
        {
            error:
                `Another request created "${error.accountName}" while this one was setting it up. ` +
                'Nothing was changed — please try again.',
            code: error.code,
            retryable: true,
        },
        { status: 503, headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) } },
    );
}
