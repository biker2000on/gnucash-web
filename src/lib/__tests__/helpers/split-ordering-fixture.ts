/**
 * The ONE fixture behind both halves of the split-ordering contract.
 *
 * The lot engine's determinism guarantee is an ORDER BY: loadUnassignedSplits
 * (src/lib/lot-assignment.ts) asks for unassigned splits by
 * post_date, then tx_guid, then guid, and the sequence it gets back decides
 * which lot each split consumes and therefore every downstream cost basis.
 *
 * That guarantee is only worth anything if the order the tests observe is the
 * order PostgreSQL actually produces. Asserting it solely through the in-memory
 * fake would grade the engine against a model written in the same commit — so
 * the rows and the expected sequences live HERE, and are asserted twice:
 *
 *   - src/lib/__tests__/fake-prisma-ordering.test.ts   — the fake, unit tier;
 *   - src/lib/__tests__/lot-outflow-ordering.integration.test.ts
 *                                                      — real PostgreSQL.
 *
 * Both read the same ORDER_BY_* specs and the same EXPECTED_*_KEYS below, so
 * the two cannot drift into agreeing on different things.
 *
 * WHAT THE ROWS EXERCISE
 *   - post_date ascending, the primary key;
 *   - a NULL post_date. `transactions.post_date` is nullable in the schema, and
 *     Postgres sorts NULL as GREATER than every value: NULLS LAST under ASC,
 *     NULLS FIRST under DESC. A fake that coerced the null to epoch 0 would
 *     place it at the opposite end;
 *   - two splits sharing a post_date, separated by tx_guid;
 *   - two splits sharing a post_date AND a tx_guid, separated by guid.
 *
 * SEED_ORDER is deliberately not the expected order for either direction, so a
 * comparator that returns 0 for everything — or an implementation that just
 * hands back insertion order — cannot pass by accident.
 */

/** One seeded split. `key` is the stable handle assertions are written in. */
export interface SplitOrderingRow {
    /** Short readable handle. Never stored; only used in expectations. */
    key: string;
    /** Suffix appended to the per-run prefix to build the 32-char split guid. */
    splitSuffix: string;
    /** Suffix appended to the per-run prefix to build the 32-char tx guid. */
    txSuffix: string;
    /** Transaction post_date, or null for a transaction that has none. */
    postDate: string | null;
}

/**
 * Guids are `<12-char run prefix><suffix padded to 20>`, which is exactly the
 * 32 chars GnuCash's VARCHAR(32) guid columns hold. Because the prefix is
 * shared, the SUFFIX alone decides the relative order under a `guid: 'asc'`
 * key — in Postgres (C-locale byte order on these ASCII-hex-ish strings) and in
 * JavaScript alike, which is what lets one expectation cover both tiers.
 */
export const RUN_PREFIX_LENGTH = 12;
const SUFFIX_LENGTH = 32 - RUN_PREFIX_LENGTH;

/** Builds a 32-char guid from a per-run prefix and a fixture suffix. */
export function orderingGuid(runPrefix: string, suffix: string): string {
    if (runPrefix.length !== RUN_PREFIX_LENGTH) {
        throw new Error(`run prefix must be ${RUN_PREFIX_LENGTH} chars, got ${runPrefix.length}`);
    }
    if (suffix.length > SUFFIX_LENGTH) {
        throw new Error(`suffix must be at most ${SUFFIX_LENGTH} chars, got ${suffix.length}`);
    }
    return runPrefix + suffix.padEnd(SUFFIX_LENGTH, '0');
}

/**
 * The fixture rows, in SEED ORDER — which matches neither expected sequence.
 *
 * 'a'..'d' as tx suffixes and '1'/'2' as split suffixes keep the intended
 * relative order obvious on inspection; padEnd with '0' cannot disturb it
 * because '0' sorts below every letter and below '1'.
 */
export const SPLIT_ORDERING_ROWS: readonly SplitOrderingRow[] = [
    // NULL post_date, and the LATER tx_guid of the two null rows.
    { key: 'null-late-tx', splitSuffix: 's1', txSuffix: 'd', postDate: null },
    // Same post_date and tx_guid as jun15-txb-split1, separated only by guid.
    { key: 'jun15-txb-split2', splitSuffix: 's2', txSuffix: 'b', postDate: '2024-06-15' },
    { key: 'jun16-txc', splitSuffix: 's1', txSuffix: 'c', postDate: '2024-06-16' },
    { key: 'jun15-txb-split1', splitSuffix: 's1', txSuffix: 'b', postDate: '2024-06-15' },
    // NULL post_date, and the EARLIER tx_guid of the two null rows.
    { key: 'null-early-tx', splitSuffix: 's1', txSuffix: 'a2', postDate: null },
    { key: 'jun15-txa', splitSuffix: 's1', txSuffix: 'a1', postDate: '2024-06-15' },
] as const;

/** The engine's own ordering: post_date, then tx_guid, then guid — all ASC. */
export const ORDER_BY_ASC = [
    { transaction: { post_date: 'asc' } },
    { tx_guid: 'asc' },
    { guid: 'asc' },
] as const;

/**
 * The same keys with post_date DESCENDING, which is the other direction the
 * codebase uses (the price lookups in lot-scrub.ts order `date: 'desc'`). Kept
 * here because NULLS FIRST under DESC is the half a NULLS-LAST-everywhere
 * implementation gets wrong, and nothing else would catch it.
 */
export const ORDER_BY_POST_DATE_DESC = [
    { transaction: { post_date: 'desc' } },
    { tx_guid: 'asc' },
    { guid: 'asc' },
] as const;

/**
 * ASC: dates ascending, then tx_guid, then guid — and the two NULL post_date
 * rows LAST, ordered between themselves by the remaining keys.
 */
export const EXPECTED_ASC_KEYS: readonly string[] = [
    'jun15-txa',
    'jun15-txb-split1',
    'jun15-txb-split2',
    'jun16-txc',
    'null-early-tx',
    'null-late-tx',
] as const;

/**
 * DESC on post_date: the NULL rows come FIRST (Postgres treats NULL as the
 * largest value, and DESC puts the largest first), then the real dates newest
 * first. The two later keys stay ASC, so ties inside one date do not reverse.
 */
export const EXPECTED_POST_DATE_DESC_KEYS: readonly string[] = [
    'null-early-tx',
    'null-late-tx',
    'jun16-txc',
    'jun15-txa',
    'jun15-txb-split1',
    'jun15-txb-split2',
] as const;

/** Ordering on `guid` ALONE, which must differ from EXPECTED_ASC_KEYS. */
export const ORDER_BY_GUID_ONLY = [{ guid: 'asc' }] as const;

/**
 * guid ascending and nothing else: s1a1, s1a2, s1b, s1c, s1d, s2b.
 *
 * Its only job is to be DIFFERENT from EXPECTED_ASC_KEYS. Without that
 * contrast, an implementation honouring any single key of the three-key order
 * could still satisfy the ASC expectation.
 *
 * It also pins the one collation assumption the shared fixture makes: the
 * suffixes are ASCII alphanumerics compared position by position, where
 * Postgres (whatever its lc_collate) and JavaScript agree. Nothing here mixes
 * case or uses punctuation, which is where the two would part company.
 */
export const EXPECTED_GUID_ONLY_KEYS: readonly string[] = [
    'jun15-txa',
    'null-early-tx',
    'jun15-txb-split1',
    'jun16-txc',
    'null-late-tx',
    'jun15-txb-split2',
] as const;

/**
 * The split guid for a fixture row. Both the split suffix AND the tx suffix go
 * into it: 'jun15-txb-split1' and 'null-late-tx' share splitSuffix 's1', so the
 * split suffix alone would not be unique.
 */
export function splitGuidOf(row: SplitOrderingRow, runPrefix: string): string {
    return orderingGuid(runPrefix, row.splitSuffix + row.txSuffix);
}

/** The transaction guid for a fixture row. Rows may share a transaction. */
export function txGuidOf(row: SplitOrderingRow, runPrefix: string): string {
    return orderingGuid(runPrefix, 't' + row.txSuffix);
}

/** Maps returned split guids back to fixture keys, for readable failures. */
export function keysOf(rows: Array<{ guid: string }>, runPrefix: string): string[] {
    const byGuid = new Map(
        SPLIT_ORDERING_ROWS.map(r => [splitGuidOf(r, runPrefix), r.key]),
    );
    return rows.map(r => byGuid.get(r.guid) ?? `unknown:${r.guid}`);
}
