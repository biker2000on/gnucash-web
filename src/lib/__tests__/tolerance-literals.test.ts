/**
 * Tripwire: bare numeric tolerance literals under `src/`.
 *
 * Every balance/quantity tolerance in this project belongs in
 * `src/lib/tolerances.ts` under a name that says WHICH tolerance it is and
 * WHEN to use it. The failure mode this test exists to stop is not any single
 * wrong number — it is the drift that happens when the number is spelled out
 * at the call site: `0.01` here and `0.005` there, so "balanced" means two
 * different things two files apart, and nobody can find every site to fix when
 * one of them turns out to be wrong.
 *
 * WHAT IT CATCHES: a comparison of a numeric expression against a bare
 * `0.005`, `0.01`, or `0.0001` literal (`< 0.005`, `>= 0.01`,
 * `Math.abs(x) < 0.0001`, `x > -0.005`, …) in a non-test source file.
 *
 * WHAT IT ALLOWS: `tolerances.ts` itself, test files, and the LEGACY sites
 * already present when the module was introduced — recorded per file in
 * {@link LEGACY_BUDGET} below. Those are overwhelmingly display predicates in
 * report and UI code ("is this row worth rendering?"), and converting all of
 * them at once would be a far riskier change than the drift it prevents.
 *
 * HOW TO SATISFY IT:
 *  - Adding a tolerance comparison? Import the named constant from
 *    `@/lib/tolerances` instead of typing the number.
 *  - Removing a legacy one? Lower that file's number here (or delete the
 *    entry). The budget only ever ratchets DOWN; raising an entry, or adding
 *    a new one, is the thing this test refuses.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');

/**
 * A comparison operator, then optional whitespace/sign, then one of the three
 * tolerance magnitudes as a bare decimal literal. Bounded so `0.0001234` and
 * `0.015` (different numbers, not the ones under management) do not match.
 */
const TOLERANCE_COMPARISON = /[<>]=?\s*-?\s*0\.(?:005|01|0001)(?![0-9])/;

/** Same magnitudes on the LEFT of the operator (`0.005 < Math.abs(x)`). */
const REVERSED_COMPARISON = /(?<![0-9.])0\.(?:005|01|0001)(?![0-9])\s*[<>]=?/;

function isSourceFile(path: string): boolean {
    if (!/\.(ts|tsx)$/.test(path)) return false;
    if (/\.test\.tsx?$/.test(path) || /\.spec\.tsx?$/.test(path)) return false;
    if (path.split(sep).includes('__tests__')) return false;
    return true;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (isSourceFile(full)) out.push(full);
    }
    return out;
}

interface Offence {
    file: string;
    line: number;
    text: string;
}

function scan(): Offence[] {
    const offences: Offence[] = [];
    for (const file of walk(SRC)) {
        const rel = relative(SRC, file).split(sep).join('/');
        if (rel === 'lib/tolerances.ts') continue;
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((text, i) => {
            const code = text.trim();
            // Comments describe tolerances; they do not implement them.
            if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
            if (TOLERANCE_COMPARISON.test(text) || REVERSED_COMPARISON.test(text)) {
                offences.push({ file: rel, line: i + 1, text: code });
            }
        });
    }
    return offences;
}

/**
 * Legacy sites, per file, as of the introduction of `src/lib/tolerances.ts`.
 *
 * Recorded as counts rather than line numbers so unrelated edits above a site
 * do not fail the build. Ratchets down only.
 */
const LEGACY_BUDGET: Record<string, number> = {
    'app/(main)/budgets/[guid]/BudgetYoY.tsx': 1,
    'app/(main)/budgets/compare/page.tsx': 1,
    'app/(main)/business/employees/page.tsx': 2,
    'app/(main)/business/invoices/[guid]/page.tsx': 3,
    'app/(main)/business/invoices/page.tsx': 1,
    'app/(main)/business/jobs/page.tsx': 1,
    'app/(main)/business/payments/page.tsx': 1,
    'app/(main)/business/reports/aging/page.tsx': 1,
    'app/(main)/business/reports/customer-summary/page.tsx': 1,
    'app/(main)/business/reports/schedule-c/page.tsx': 1,
    'app/(main)/business/reports/schedule-e/page.tsx': 1,
    'app/(main)/business/reports/schedule-f/page.tsx': 1,
    'app/(main)/business/vouchers/page.tsx': 2,
    'app/(main)/dashboard/page.tsx': 1,
    'app/(main)/import-export/settlements/page.tsx': 1,
    'app/(main)/investments/accounts/page.tsx': 1,
    'app/(main)/investments/rebalancing/TargetEditor.tsx': 2,
    'app/(main)/reports/income_statement_by_period/page.tsx': 3,
    'app/(main)/reports/stock_valuation/page.tsx': 1,
    'app/(main)/taxes/estimated/page.tsx': 6,
    'app/(main)/tools/charitable-bunching/page.tsx': 1,
    'app/(main)/tools/debt-payoff/page.tsx': 1,
    'app/(main)/tools/filing-comparison/page.tsx': 4,
    'app/(main)/tools/paycheck-modeler/page.tsx': 2,
    'app/(main)/tools/sell-planner/PlanComparisonCards.tsx': 2,
    'app/(main)/tools/sell-planner/PlanLotTable.tsx': 2,
    'app/(main)/tools/withholding/WithholdingHeadline.tsx': 1,
    'app/(main)/tools/withholding/page.tsx': 3,
    'app/api/reports/treasurer/route.ts': 1,
    'app/api/tax/estimated/route.ts': 1,
    'app/api/tools/drawdown/prefill/route.ts': 1,
    'components/AccountLedger.tsx': 2,
    'components/TransactionForm.tsx': 2,
    'components/business/PaymentModal.tsx': 3,
    'components/business/invoice-ui.ts': 3,
    'components/payslips/TransactionPreview.tsx': 1,
    'components/reports/TreasurerReport.tsx': 1,
    'components/reports/TrialBalanceTable.tsx': 1,
    'lib/asset-transaction-service.ts': 1,
    'lib/business/business-reports.ts': 1,
    'lib/business/customer-statement.ts': 1,
    'lib/business/schedule-f.ts': 1,
    'lib/close-book.ts': 2,
    'lib/data-health.ts': 3,
    'lib/domain-commands.ts': 2,
    'lib/emergency-info.ts': 1,
    'lib/family-office/service.ts': 1,
    'lib/financial-actions/sources.ts': 2,
    'lib/import/qbo-gl.ts': 3,
    'lib/import/qbo-journal.ts': 1,
    'lib/import/settlements.ts': 2,
    'lib/import/wave.ts': 1,
    'lib/import/xero.ts': 1,
    'lib/qif/importer.ts': 1,
    'lib/qif/parser.ts': 1,
    'lib/rebalancing-sector.ts': 2,
    'lib/rebalancing.ts': 1,
    'lib/receipt-matching.ts': 2,
    'lib/reports/balance-sheet.ts': 1,
    'lib/reports/general-ledger.ts': 1,
    'lib/reports/member-spending.ts': 1,
    'lib/reports/net-worth-attribution.ts': 9,
    'lib/reports/net-worth-by-owner.ts': 1,
    'lib/reports/schedule-e.ts': 1,
    'lib/reports/trial-balance.ts': 1,
    'lib/reports/year-in-review.ts': 6,
    'lib/tax/book-income.ts': 2,
    'lib/tax/farm-book-data.ts': 1,
    'lib/tax/filing-comparison.ts': 2,
    'lib/tax/tax-schedule.ts': 1,
    'lib/withholding.ts': 8,
};

describe('tolerance literals', () => {
    const offences = scan();
    const byFile = new Map<string, Offence[]>();
    for (const o of offences) {
        byFile.set(o.file, [...(byFile.get(o.file) ?? []), o]);
    }

    it('adds no new bare 0.005 / 0.01 / 0.0001 tolerance comparison', () => {
        const news: string[] = [];
        for (const [file, found] of byFile) {
            const allowed = LEGACY_BUDGET[file] ?? 0;
            if (found.length > allowed) {
                for (const o of found.slice(allowed)) {
                    news.push(`${o.file}:${o.line}  ${o.text}`);
                }
            }
        }
        expect(
            news,
            'Bare tolerance literals must come from src/lib/tolerances.ts.\n' +
            'Import the named constant whose doc comment matches what you are comparing:\n' +
            '  money already rounded to cents  -> MONEY_DISPLAY_EPSILON / moneyEpsilonForScu(scu)\n' +
            '  share or unit counts            -> qtyEpsilonForScu(scu)\n' +
            '  counts accumulated over a replay-> qtyEpsilonWithMagnitude(scu, magnitude)\n' +
            '  validating a ledger write       -> assertBalanced() (exact BigInt, no epsilon)\n\n' +
            'New offending lines:\n' + news.join('\n'),
        ).toEqual([]);
    });

    it('keeps the legacy budget honest (no entry larger than the code needs)', () => {
        const stale = Object.entries(LEGACY_BUDGET)
            .filter(([file, allowed]) => (byFile.get(file)?.length ?? 0) < allowed)
            .map(([file, allowed]) => `${file}: budget ${allowed}, found ${byFile.get(file)?.length ?? 0}`);
        expect(
            stale,
            'These files now have FEWER bare tolerance literals than their budget.\n' +
            'Lower (or delete) the LEGACY_BUDGET entries so the ratchet cannot slip back:\n' +
            stale.join('\n'),
        ).toEqual([]);
    });
});
