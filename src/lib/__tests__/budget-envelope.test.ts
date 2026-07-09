/**
 * Unit tests for the pure envelope/rollover math and alert evaluation in
 * src/lib/budget-envelope.ts. No database access — loaders are not tested here.
 */

import { describe, it, expect } from 'vitest';
import {
    computeRollovers,
    evaluateBudgetAlerts,
    budgetAlertDedupeKey,
    DEFAULT_ALERT_THRESHOLD_PCT,
    type EnvelopeConfig,
    type EnvelopeAccountInput,
    type AlertEvalAccount,
} from '@/lib/budget-envelope';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeAccount(
    guid: string,
    budgeted: number[],
    actual: number[]
): EnvelopeAccountInput {
    return {
        guid,
        periods: budgeted.map((b, i) => ({ periodNum: i, budgeted: b, actual: actual[i] ?? 0 })),
    };
}

function config(
    accountGuid: string,
    overrides: Partial<Omit<EnvelopeConfig, 'accountGuid'>> = {}
): EnvelopeConfig {
    return {
        accountGuid,
        rolloverEnabled: true,
        alertThresholdPct: null,
        goalId: null,
        ...overrides,
    };
}

function evalAccount(
    guid: string,
    name: string,
    overrides: Partial<AlertEvalAccount> = {}
): AlertEvalAccount {
    return {
        guid,
        name,
        type: 'EXPENSE',
        currency: 'USD',
        periods: [{ periodNum: 0, budgeted: 100, actual: 0 }],
        pacing: null,
        ...overrides,
    };
}

const BUDGET = 'b'.repeat(32);
const ACCT = 'a'.repeat(32);

/* ------------------------------------------------------------------ */
/* computeRollovers                                                    */
/* ------------------------------------------------------------------ */

describe('computeRollovers', () => {
    it('carries surplus forward cumulatively across periods', () => {
        // Budget 100/period; spend 40, 60, 80 → surpluses 60, then 100, then 120.
        const acc = makeAccount(ACCT, [100, 100, 100], [40, 60, 80]);
        const [env] = computeRollovers([acc], [config(ACCT)], 2);

        expect(env.rolloverEnabled).toBe(true);
        expect(env.periods[0]).toEqual({
            periodNum: 0, carryIn: 0, effectiveBudgeted: 100, effectiveRemaining: 60,
        });
        expect(env.periods[1]).toEqual({
            periodNum: 1, carryIn: 60, effectiveBudgeted: 160, effectiveRemaining: 100,
        });
        expect(env.periods[2]).toEqual({
            periodNum: 2, carryIn: 100, effectiveBudgeted: 200, effectiveRemaining: 120,
        });
        expect(env.availableNow).toBe(120);
    });

    it('carries overspend deficits forward as negative carry', () => {
        // Budget 100/period; overspend period 0 by 50 → period 1 starts at 50.
        const acc = makeAccount(ACCT, [100, 100, 100], [150, 30, 0]);
        const [env] = computeRollovers([acc], [config(ACCT)], 1);

        expect(env.periods[0].effectiveRemaining).toBe(-50);
        expect(env.periods[1].carryIn).toBe(-50);
        expect(env.periods[1].effectiveBudgeted).toBe(50);
        expect(env.periods[1].effectiveRemaining).toBe(20);
        expect(env.availableNow).toBe(20);
    });

    it('accumulates sinking funds (budget monthly, spend rarely)', () => {
        // 50/month for a bill paid in period 5.
        const acc = makeAccount(ACCT, [50, 50, 50, 50, 50, 50], [0, 0, 0, 0, 0, 280]);
        const [env] = computeRollovers([acc], [config(ACCT)], 5);

        expect(env.periods[4].effectiveRemaining).toBe(250);
        expect(env.periods[5].carryIn).toBe(250);
        expect(env.periods[5].effectiveBudgeted).toBe(300);
        expect(env.periods[5].effectiveRemaining).toBe(20);
        expect(env.availableNow).toBe(20);
    });

    it('does not carry for disabled or unconfigured lines', () => {
        const enabled = makeAccount('e'.repeat(32), [100, 100], [40, 0]);
        const disabled = makeAccount('d'.repeat(32), [100, 100], [40, 0]);
        const unconfigured = makeAccount('u'.repeat(32), [100, 100], [40, 0]);

        const result = computeRollovers(
            [enabled, disabled, unconfigured],
            [
                config('e'.repeat(32)),
                config('d'.repeat(32), { rolloverEnabled: false }),
            ],
            1
        );

        const byGuid = new Map(result.map(e => [e.accountGuid, e]));
        expect(byGuid.get('e'.repeat(32))!.periods[1].carryIn).toBe(60);
        expect(byGuid.get('e'.repeat(32))!.availableNow).toBe(160);

        for (const guid of ['d'.repeat(32), 'u'.repeat(32)]) {
            const env = byGuid.get(guid)!;
            expect(env.rolloverEnabled).toBe(false);
            expect(env.periods.every(p => p.carryIn === 0)).toBe(true);
            expect(env.periods[1].effectiveBudgeted).toBe(100);
            expect(env.availableNow).toBe(100); // plain remaining, no carry
        }
    });

    it('handles empty config (all lines behave as plain budget lines)', () => {
        const acc = makeAccount(ACCT, [100, 100], [120, 50]);
        const [env] = computeRollovers([acc], [], 1);

        expect(env.rolloverEnabled).toBe(false);
        expect(env.periods[0].effectiveRemaining).toBe(-20);
        expect(env.periods[1].carryIn).toBe(0);
        expect(env.periods[1].effectiveRemaining).toBe(50);
    });

    it('returns null availableNow when there is no current period', () => {
        const acc = makeAccount(ACCT, [100], [0]);
        const [env] = computeRollovers([acc], [config(ACCT)], null);
        expect(env.availableNow).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* evaluateBudgetAlerts                                                */
/* ------------------------------------------------------------------ */

describe('evaluateBudgetAlerts', () => {
    it('fires a threshold alert at exactly the default 80%', () => {
        const accounts = [evalAccount(ACCT, 'Groceries', {
            periods: [{ periodNum: 0, budgeted: 100, actual: 80 }],
        })];
        const alerts = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);

        expect(DEFAULT_ALERT_THRESHOLD_PCT).toBe(80);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].kind).toBe('threshold');
        expect(alerts[0].pctUsed).toBe(80);
        expect(alerts[0].message).toContain('80%');
    });

    it('does not fire a threshold alert just below the threshold', () => {
        const accounts = [evalAccount(ACCT, 'Groceries', {
            periods: [{ periodNum: 0, budgeted: 100, actual: 79.99 }],
        })];
        const alerts = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);
        expect(alerts).toHaveLength(0);
    });

    it('fires an over alert (and suppresses the implied threshold alert)', () => {
        const accounts = [evalAccount(ACCT, 'Dining', {
            periods: [{ periodNum: 0, budgeted: 100, actual: 130 }],
        })];
        const alerts = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);

        expect(alerts).toHaveLength(1);
        expect(alerts[0].kind).toBe('over');
        expect(alerts[0].actual).toBe(130);
        expect(alerts[0].budgeted).toBe(100);
    });

    it('fires a projected alert when pacing projects an overspend', () => {
        const accounts = [evalAccount(ACCT, 'Gas', {
            periods: [{ periodNum: 0, budgeted: 100, actual: 50 }],
            pacing: { projected: 150, status: 'warning' },
        })];
        const alerts = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);

        expect(alerts).toHaveLength(1);
        expect(alerts[0].kind).toBe('projected');
        expect(alerts[0].message).toContain('pacing');
    });

    it('respects per-line threshold overrides from the envelope config', () => {
        const accounts = [evalAccount(ACCT, 'Travel', {
            periods: [{ periodNum: 0, budgeted: 100, actual: 60 }],
        })];

        const noOverride = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);
        expect(noOverride).toHaveLength(0);

        const withOverride = evaluateBudgetAlerts(
            { budgetGuid: BUDGET, currentPeriod: 0, accounts },
            [config(ACCT, { alertThresholdPct: 50 })]
        );
        expect(withOverride).toHaveLength(1);
        expect(withOverride[0].kind).toBe('threshold');
    });

    it('never alerts on income accounts', () => {
        const accounts = [evalAccount(ACCT, 'Salary', {
            type: 'INCOME',
            periods: [{ periodNum: 0, budgeted: 100, actual: 500 }],
            pacing: { projected: 1000, status: 'over' },
        })];
        const alerts = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);
        expect(alerts).toHaveLength(0);
    });

    it('emits stable, well-formed dedupe keys', () => {
        const accounts = [evalAccount(ACCT, 'Dining', {
            periods: [{ periodNum: 0, budgeted: 100, actual: 130 }],
        })];
        const run1 = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);
        const run2 = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);

        expect(run1[0].dedupeKey).toBe(run2[0].dedupeKey);
        expect(run1[0].dedupeKey).toBe(`${BUDGET}:${ACCT}:p0:over`);
        expect(run1[0].dedupeKey).toBe(budgetAlertDedupeKey(BUDGET, ACCT, 0, 'over'));

        // Different kind / period / account → different key.
        expect(budgetAlertDedupeKey(BUDGET, ACCT, 0, 'threshold')).not.toBe(run1[0].dedupeKey);
        expect(budgetAlertDedupeKey(BUDGET, ACCT, 1, 'over')).not.toBe(run1[0].dedupeKey);
    });

    it('evaluates against the carry-adjusted budget when rollovers are provided', () => {
        // Raw: 110 spent of 100 → 'over'. With +50 carried in, effective budget
        // is 150 → 73% used → no alert at the default threshold.
        const input = makeAccount(ACCT, [100, 100], [50, 110]);
        const cfg = [config(ACCT)];
        const rollovers = computeRollovers([input], cfg, 1);

        const accounts = [evalAccount(ACCT, 'Utilities', {
            periods: input.periods,
        })];

        const raw = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 1, accounts }, cfg);
        expect(raw).toHaveLength(1);
        expect(raw[0].kind).toBe('over');

        const adjusted = evaluateBudgetAlerts(
            { budgetGuid: BUDGET, currentPeriod: 1, accounts },
            cfg,
            {},
            rollovers
        );
        expect(adjusted).toHaveLength(0);
    });

    it('returns nothing when there is no current period or nothing to alert on', () => {
        const accounts = [evalAccount(ACCT, 'Groceries', {
            periods: [{ periodNum: 0, budgeted: 100, actual: 200 }],
        })];
        expect(evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: null, accounts }, [])).toHaveLength(0);

        // Zero budget and zero spend → skipped entirely.
        const idle = [evalAccount(ACCT, 'Idle', {
            periods: [{ periodNum: 0, budgeted: 0, actual: 0 }],
        })];
        expect(evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts: idle }, [])).toHaveLength(0);
    });

    it('flags unbudgeted spend on a configured expense line as over', () => {
        const accounts = [evalAccount(ACCT, 'Surprise', {
            periods: [{ periodNum: 0, budgeted: 0, actual: 25 }],
        })];
        const alerts = evaluateBudgetAlerts({ budgetGuid: BUDGET, currentPeriod: 0, accounts }, []);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].kind).toBe('over');
        expect(alerts[0].pctUsed).toBeNull();
    });
});
