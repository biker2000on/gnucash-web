import type { ScheduleCReport } from '@/lib/business/business-reports';
import type { ContributionSummaryData } from '@/lib/reports/types';
import type { WithholdingCheckupPayload } from '@/lib/withholding';
import type { CharitableGivingReport } from './charitable-giving';

/**
 * Year-end tax package: pure converters that turn existing report payloads
 * into the CSV/text files bundled by /api/reports/tax-package.
 * (The Form 8949 / Schedule D CSVs come from lib/reports/capital-gains.)
 */

export function csvEscape(value: string | number | null | undefined): string {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function csvLine(cells: Array<string | number | null | undefined>): string {
    return cells.map(csvEscape).join(',');
}

const money = (n: number): string => n.toFixed(2);

export function contributionSummaryToCSV(data: ContributionSummaryData, year: number): string {
    const lines: string[] = [
        csvLine(['Year', 'Account', 'Retirement Type', 'Contributions', 'Employer Match', 'Income (Dividends etc.)', 'Transfers/Rollovers', 'Withdrawals', 'Fees', 'Net Contributions', 'IRS Limit', 'Limit Used %']),
    ];
    for (const period of data.periods) {
        if (period.year !== year) continue;
        for (const acct of period.accounts) {
            const limit = acct.irsLimit?.total ?? null;
            lines.push(csvLine([
                period.year,
                acct.accountPath,
                acct.retirementAccountType ?? '',
                money(acct.contributions),
                money(acct.employerMatch),
                money(acct.incomeContributions),
                money(acct.transfers),
                money(acct.withdrawals),
                money(acct.fees),
                money(acct.netContributions),
                limit !== null ? money(limit) : '',
                limit ? `${Math.round((acct.contributions / limit) * 100)}%` : '',
            ]));
        }
        lines.push(csvLine([
            period.year, 'TOTAL', '',
            money(period.totalContributions),
            money(period.totalEmployerMatch),
            money(period.totalIncomeContributions),
            money(period.totalTransfers),
            money(period.totalWithdrawals),
            money(period.totalFees),
            money(period.totalNetContributions),
            '', '',
        ]));
    }
    return lines.join('\r\n') + '\r\n';
}

export function scheduleCToCSV(report: ScheduleCReport): string {
    const lines: string[] = [
        csvLine(['Line', 'Description', 'Amount', 'Deductible']),
        csvLine(['1', 'Gross receipts or sales', money(report.grossReceipts), money(report.grossReceipts)]),
    ];
    for (const line of report.lines) {
        if (line.amount === 0 && line.deductible === 0) continue;
        lines.push(csvLine([line.line, line.label, money(line.amount), money(line.deductible)]));
    }
    lines.push(csvLine(['28', 'Total expenses', money(report.totalExpenses), money(report.totalExpenses)]));
    lines.push(csvLine(['31', 'Net profit or (loss)', money(report.netProfit), money(report.netProfit)]));
    return lines.join('\r\n') + '\r\n';
}

export function charitableGivingToCSV(report: CharitableGivingReport): string {
    const lines: string[] = [
        csvLine(['Date', 'Payee', 'Account', 'Memo', 'Amount']),
    ];
    for (const acct of report.accounts) {
        for (const d of acct.donations) {
            lines.push(csvLine([d.date, d.payee, acct.accountPath, d.memo, money(d.amount)]));
        }
    }
    lines.push(csvLine(['', '', '', 'TOTAL', money(report.grandTotal)]));
    return lines.join('\r\n') + '\r\n';
}

export function withholdingToText(payload: WithholdingCheckupPayload): string {
    const c = payload.checkup;
    const m = payload.meta;
    const out: string[] = [
        `Withholding Checkup — ${m.year}`,
        `Filing status: ${m.filingStatus}`,
        `As of: ${m.asOfDate} (${m.annualized ? 'annualized' : 'year-to-date treated as full year'})`,
        '',
        `Projected AGI:                 $${c.projectedAgi.toFixed(2)}`,
        `Projected federal liability:   $${c.projectedLiability.toFixed(2)}`,
        `YTD federal withholding:       $${c.ytdWithholding.toFixed(2)}`,
        `YTD estimated payments:        $${c.ytdEstimatedPayments.toFixed(2)}`,
        `Projected total payments:      $${c.projectedTotalPayments.toFixed(2)}`,
        `Projected balance:             $${c.projectedBalance.toFixed(2)} (${c.projectedBalance >= 0 ? 'refund' : 'owed'})`,
        `Status: ${c.status}${c.underWithheld ? ' — UNDER-WITHHELD' : ''}`,
    ];
    return out.join('\r\n') + '\r\n';
}

export interface TaxPackageManifestInput {
    year: number;
    generatedAt: string;
    files: Array<{ name: string; description: string }>;
    notes: string[];
}

export function buildManifest(input: TaxPackageManifestInput): string {
    const lines: string[] = [
        `GnuCash Web — Year-End Tax Package for ${input.year}`,
        `Generated: ${input.generatedAt}`,
        '',
        'Contents:',
        ...input.files.map(f => `  - ${f.name}: ${f.description}`),
    ];
    if (input.notes.length > 0) {
        lines.push('', 'Notes:');
        for (const n of input.notes) lines.push(`  * ${n}`);
    }
    lines.push('', 'These figures are estimates prepared from your books. Verify against official forms (W-2, 1099, 1098) before filing.');
    return lines.join('\r\n') + '\r\n';
}
