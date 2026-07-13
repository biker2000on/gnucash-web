/**
 * Price Alerts
 *
 * User-defined thresholds on commodity prices ("notify me when AAPL goes
 * above 250"). Alerts live in a lazily created gnucash_web_price_alerts
 * table (advisory-lock pattern, same as backup.ts). `checkPriceAlerts()`
 * compares the latest stored price of each alerted commodity against its
 * threshold and, when crossed (and not re-triggered within 24 hours),
 * creates an in-app notification and stamps last_triggered_at.
 *
 * The trigger decision itself — `evaluateAlert()` — is pure and unit tested.
 */

import prisma from '@/lib/prisma';
import { createNotification } from '@/lib/notifications';

export type PriceAlertDirection = 'above' | 'below';

export interface PriceAlertRecord {
    id: number;
    userId: number;
    bookGuid: string;
    commodityGuid: string;
    direction: PriceAlertDirection;
    threshold: number;
    enabled: boolean;
    lastTriggeredAt: Date | null;
    createdAt: Date;
}

export interface PriceAlertInput {
    commodityGuid: string;
    direction: PriceAlertDirection;
    threshold: number;
}

export class PriceAlertValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PriceAlertValidationError';
    }
}

/* ------------------------------------------------------------------ */
/* Pure core                                                           */
/* ------------------------------------------------------------------ */

/** Minimum time between two notifications for the same alert. */
export const RETRIGGER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EvaluableAlert {
    direction: PriceAlertDirection;
    threshold: number;
    enabled: boolean;
    lastTriggeredAt: Date | null;
}

/**
 * Should this alert fire for the given price right now?
 * - disabled alerts never fire;
 * - 'above' fires when price >= threshold, 'below' when price <= threshold
 *   (touching the threshold counts as crossed);
 * - an alert that fired within the last 24 hours is suppressed.
 */
export function evaluateAlert(
    alert: EvaluableAlert,
    price: number,
    now: Date = new Date(),
): boolean {
    if (!alert.enabled) return false;
    if (!Number.isFinite(price) || !Number.isFinite(alert.threshold)) return false;

    const crossed = alert.direction === 'above'
        ? price >= alert.threshold
        : price <= alert.threshold;
    if (!crossed) return false;

    if (alert.lastTriggeredAt &&
        now.getTime() - alert.lastTriggeredAt.getTime() < RETRIGGER_WINDOW_MS) {
        return false;
    }
    return true;
}

/** Validate a create/update payload; throws PriceAlertValidationError. */
export function validatePriceAlertInput(input: PriceAlertInput): PriceAlertInput {
    if (typeof input.commodityGuid !== 'string' || input.commodityGuid.length !== 32) {
        throw new PriceAlertValidationError('commodityGuid must be a 32-character GUID');
    }
    if (input.direction !== 'above' && input.direction !== 'below') {
        throw new PriceAlertValidationError("direction must be 'above' or 'below'");
    }
    const threshold = Number(input.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) {
        throw new PriceAlertValidationError('threshold must be a positive number');
    }
    return { commodityGuid: input.commodityGuid, direction: input.direction, threshold };
}

/* ------------------------------------------------------------------ */
/* Lazy table (advisory-lock pattern)                                  */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensurePriceAlertsTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_price_alerts_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_price_alerts (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
                    book_guid VARCHAR(32) NOT NULL,
                    commodity_guid VARCHAR(32) NOT NULL,
                    direction VARCHAR(8) NOT NULL CHECK (direction IN ('above', 'below')),
                    threshold DOUBLE PRECISION NOT NULL,
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    last_triggered_at TIMESTAMP,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  );

                  CREATE INDEX IF NOT EXISTS idx_price_alerts_user
                    ON gnucash_web_price_alerts(user_id, book_guid, created_at DESC);
                  CREATE INDEX IF NOT EXISTS idx_price_alerts_enabled
                    ON gnucash_web_price_alerts(commodity_guid)
                    WHERE enabled;
                END $$;
            `);
        })();
        // Allow retry after a transient failure instead of caching the rejection.
        ensurePromise.catch(() => { ensurePromise = null; });
    }
    return ensurePromise;
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

interface PriceAlertRow {
    id: number;
    user_id: number;
    book_guid: string;
    commodity_guid: string;
    direction: string;
    threshold: number;
    enabled: boolean;
    last_triggered_at: Date | null;
    created_at: Date;
}

function rowToRecord(row: PriceAlertRow): PriceAlertRecord {
    return {
        id: row.id,
        userId: row.user_id,
        bookGuid: row.book_guid,
        commodityGuid: row.commodity_guid,
        direction: row.direction === 'below' ? 'below' : 'above',
        threshold: Number(row.threshold),
        enabled: row.enabled,
        lastTriggeredAt: row.last_triggered_at,
        createdAt: row.created_at,
    };
}

/** List a user's alerts for a book, newest first. */
export async function listPriceAlerts(userId: number, bookGuid: string): Promise<PriceAlertRecord[]> {
    await ensurePriceAlertsTable();
    const rows = await prisma.$queryRaw<PriceAlertRow[]>`
        SELECT id, user_id, book_guid, commodity_guid, direction, threshold,
               enabled, last_triggered_at, created_at
        FROM gnucash_web_price_alerts
        WHERE user_id = ${userId} AND book_guid = ${bookGuid}
        ORDER BY created_at DESC
    `;
    return rows.map(rowToRecord);
}

export async function createPriceAlert(
    userId: number,
    bookGuid: string,
    input: PriceAlertInput,
): Promise<PriceAlertRecord> {
    await ensurePriceAlertsTable();
    const validated = validatePriceAlertInput(input);
    const rows = await prisma.$queryRaw<PriceAlertRow[]>`
        INSERT INTO gnucash_web_price_alerts
            (user_id, book_guid, commodity_guid, direction, threshold)
        VALUES
            (${userId}, ${bookGuid}, ${validated.commodityGuid},
             ${validated.direction}, ${validated.threshold})
        RETURNING id, user_id, book_guid, commodity_guid, direction, threshold,
                  enabled, last_triggered_at, created_at
    `;
    return rowToRecord(rows[0]);
}

export interface PriceAlertUpdate {
    enabled?: boolean;
    direction?: PriceAlertDirection;
    threshold?: number;
}

/** Update an alert (own alerts only). Returns the updated record or null. */
export async function updatePriceAlert(
    userId: number,
    alertId: number,
    update: PriceAlertUpdate,
): Promise<PriceAlertRecord | null> {
    await ensurePriceAlertsTable();

    if (update.direction !== undefined &&
        update.direction !== 'above' && update.direction !== 'below') {
        throw new PriceAlertValidationError("direction must be 'above' or 'below'");
    }
    if (update.threshold !== undefined) {
        const t = Number(update.threshold);
        if (!Number.isFinite(t) || t <= 0) {
            throw new PriceAlertValidationError('threshold must be a positive number');
        }
    }

    const rows = await prisma.$queryRaw<PriceAlertRow[]>`
        UPDATE gnucash_web_price_alerts
        SET enabled = COALESCE(${update.enabled ?? null}::boolean, enabled),
            direction = COALESCE(${update.direction ?? null}::varchar, direction),
            threshold = COALESCE(${update.threshold ?? null}::double precision, threshold)
        WHERE id = ${alertId} AND user_id = ${userId}
        RETURNING id, user_id, book_guid, commodity_guid, direction, threshold,
                  enabled, last_triggered_at, created_at
    `;
    return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

/** Delete an alert (own alerts only). Returns true when a row was removed. */
export async function deletePriceAlert(userId: number, alertId: number): Promise<boolean> {
    await ensurePriceAlertsTable();
    const count = await prisma.$executeRaw`
        DELETE FROM gnucash_web_price_alerts
        WHERE id = ${alertId} AND user_id = ${userId}
    `;
    return count > 0;
}

/* ------------------------------------------------------------------ */
/* Alert checking (called by the check-price-alerts job)               */
/* ------------------------------------------------------------------ */

export interface CheckPriceAlertsResult {
    checked: number;
    triggered: number;
}

/**
 * Compare the latest stored price of every alerted commodity against the
 * alert thresholds. Crossed alerts (not re-triggered within 24h) produce a
 * 'price_alert' notification linking to the price history report, and get
 * their last_triggered_at stamped.
 */
export async function checkPriceAlerts(now: Date = new Date()): Promise<CheckPriceAlertsResult> {
    await ensurePriceAlertsTable();

    const alertRows = await prisma.$queryRaw<PriceAlertRow[]>`
        SELECT id, user_id, book_guid, commodity_guid, direction, threshold,
               enabled, last_triggered_at, created_at
        FROM gnucash_web_price_alerts
        WHERE enabled
    `;
    const alerts = alertRows.map(rowToRecord);
    if (alerts.length === 0) return { checked: 0, triggered: 0 };

    const commodityGuids = [...new Set(alerts.map(a => a.commodityGuid))];

    // Latest stored price per alerted commodity.
    const priceRows = await prisma.$queryRaw<Array<{
        commodity_guid: string;
        value_num: bigint;
        value_denom: bigint;
        date: Date;
    }>>`
        SELECT DISTINCT ON (commodity_guid) commodity_guid, value_num, value_denom, date
        FROM prices
        WHERE commodity_guid = ANY(${commodityGuids}::text[])
        ORDER BY commodity_guid, date DESC
    `;
    const latestPrice = new Map<string, { price: number; date: Date }>();
    for (const row of priceRows) {
        const denom = Number(row.value_denom);
        if (!denom) continue;
        latestPrice.set(row.commodity_guid, {
            price: Number(row.value_num) / denom,
            date: row.date,
        });
    }

    const commodities = await prisma.commodities.findMany({
        where: { guid: { in: commodityGuids } },
        select: { guid: true, mnemonic: true, fullname: true },
    });
    const nameByGuid = new Map(commodities.map(c => [c.guid, c.mnemonic || c.fullname || c.guid]));

    let triggered = 0;
    for (const alert of alerts) {
        const latest = latestPrice.get(alert.commodityGuid);
        if (!latest) continue;
        if (!evaluateAlert(alert, latest.price, now)) continue;

        const symbol = nameByGuid.get(alert.commodityGuid) ?? alert.commodityGuid;
        const priceText = latest.price.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
        const thresholdText = alert.threshold.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });

        try {
            await createNotification({
                userId: alert.userId,
                bookGuid: alert.bookGuid,
                type: 'price_alert',
                severity: 'info',
                title: `${symbol} is ${alert.direction} ${thresholdText}`,
                message: `Latest price ${priceText} (as of ${latest.date.toISOString().slice(0, 10)}) crossed your ${alert.direction} ${thresholdText} alert.`,
                href: `/reports/price_history?commodityGuid=${alert.commodityGuid}`,
                source: 'price_alert',
                sourceId: `price-alert:${alert.id}:${latest.date.toISOString().slice(0, 10)}`,
            });
            await prisma.$executeRaw`
                UPDATE gnucash_web_price_alerts
                SET last_triggered_at = NOW()
                WHERE id = ${alert.id}
            `;
            triggered++;
        } catch (err) {
            console.warn(`Price alert ${alert.id}: failed to notify:`, err);
        }
    }

    return { checked: alerts.length, triggered };
}
