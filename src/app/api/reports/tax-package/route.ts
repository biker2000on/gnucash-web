import { NextRequest, NextResponse } from 'next/server';
import { zipSync, strToU8 } from 'fflate';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { getPreference } from '@/lib/user-preferences';
import {
  loadCapitalGainsReport,
  generateForm8949CSV,
  generateScheduleDCSV,
} from '@/lib/reports/capital-gains';
import { generateContributionSummary } from '@/lib/reports/contribution-summary';
import { generateScheduleC } from '@/lib/business/business-reports';
import { getMappings } from '@/lib/business/schedule-c-mappings';
import { generateCharitableGiving } from '@/lib/reports/charitable-giving';
import { loadWithholdingCheckup } from '@/lib/withholding';
import { getEntityProfile } from '@/lib/services/entity.service';
import { FILING_STATUSES, isSupportedTaxYear, type FilingStatus } from '@/lib/tax/types';
import {
  contributionSummaryToCSV,
  scheduleCToCSV,
  charitableGivingToCSV,
  withholdingToText,
  buildManifest,
} from '@/lib/reports/tax-package';

/**
 * GET /api/reports/tax-package?year=2025
 *
 * One-click "give this to your accountant" bundle: a ZIP containing
 * Form 8949 + Schedule D CSVs, contribution summary, Schedule C estimate
 * (when the book has business activity), charitable giving detail, a
 * withholding checkup snapshot (supported tax years only), and a README
 * manifest. Auth: readonly. Book-scoped.
 */
export async function GET(request: NextRequest) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { user } = roleResult;

    const { searchParams } = new URL(request.url);
    const yearParam = parseInt(searchParams.get('year') ?? '', 10);
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear() - 1;
    if (year < 1990 || year > 2200) {
      return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
    }

    const bookAccountGuids = await getBookAccountGuids();
    const files: Record<string, Uint8Array> = {};
    const manifestFiles: Array<{ name: string; description: string }> = [];
    const notes: string[] = [];

    // --- Form 8949 + Schedule D ------------------------------------------
    try {
      const capitalGains = await loadCapitalGainsReport(bookAccountGuids, year);
      const has8949Rows = capitalGains.buckets?.some(b => b.rows.length > 0);
      if (has8949Rows) {
        files[`form-8949-${year}.csv`] = strToU8('﻿' + generateForm8949CSV(capitalGains));
        files[`schedule-d-${year}.csv`] = strToU8('﻿' + generateScheduleDCSV(capitalGains));
        manifestFiles.push(
          { name: `form-8949-${year}.csv`, description: 'Realized sales in IRS Form 8949 column order, bucketed by box' },
          { name: `schedule-d-${year}.csv`, description: 'Schedule D short/long-term totals' },
        );
      } else {
        notes.push(`No realized sales found for ${year}; Form 8949 / Schedule D omitted.`);
      }
    } catch (err) {
      console.error('tax-package: capital gains failed', err);
      notes.push('Form 8949 / Schedule D could not be generated (see server logs).');
    }

    // --- Contribution summary --------------------------------------------
    try {
      const birthday = await getPreference<string | null>(user.id, 'birthday', null);
      const contributions = await generateContributionSummary(
        {
          startDate: `${year}-01-01`,
          endDate: `${year}-12-31`,
          bookAccountGuids,
        },
        'tax_year',
        birthday,
      );
      const hasRows = contributions.periods.some(p => p.year === year && p.accounts.length > 0);
      if (hasRows) {
        files[`contributions-${year}.csv`] = strToU8('﻿' + contributionSummaryToCSV(contributions, year));
        manifestFiles.push({ name: `contributions-${year}.csv`, description: 'Retirement/HSA contributions per account with IRS limits' });
      } else {
        notes.push(`No retirement contributions found for ${year}.`);
      }
    } catch (err) {
      console.error('tax-package: contributions failed', err);
      notes.push('Contribution summary could not be generated (see server logs).');
    }

    // --- Schedule C (only when the book has business activity) ------------
    try {
      const overrides = await getMappings(bookAccountGuids);
      const scheduleC = await generateScheduleC(bookAccountGuids, year, overrides);
      if (scheduleC.grossReceipts !== 0 || scheduleC.totalExpenses !== 0) {
        files[`schedule-c-${year}.csv`] = strToU8('﻿' + scheduleCToCSV(scheduleC));
        manifestFiles.push({ name: `schedule-c-${year}.csv`, description: 'Schedule C estimate (sole proprietor income/expense lines)' });
      }
    } catch (err) {
      console.error('tax-package: schedule C failed', err);
      notes.push('Schedule C could not be generated (see server logs).');
    }

    // --- Charitable giving -------------------------------------------------
    try {
      const charitable = await generateCharitableGiving(bookAccountGuids, year);
      if (charitable.accounts.length > 0) {
        files[`charitable-giving-${year}.csv`] = strToU8('﻿' + charitableGivingToCSV(charitable));
        manifestFiles.push({ name: `charitable-giving-${year}.csv`, description: 'Donation detail (Schedule A) grouped by account' });
        if (charitable.largeDonationCount > 0) {
          notes.push(`${charitable.largeDonationCount} donation(s) of $250+ require written acknowledgment from the charity.`);
        }
      } else {
        notes.push('No charitable giving accounts detected (accounts named donation/charity/tithe/etc.).');
      }
    } catch (err) {
      console.error('tax-package: charitable giving failed', err);
      notes.push('Charitable giving summary could not be generated (see server logs).');
    }

    // --- Withholding checkup (supported engine years only) -----------------
    // Only for books filing a personal 1040; skipped for business entities.
    const entity = await getEntityProfile(roleResult.bookGuid, user.id);
    const filesPersonal1040 =
      entity.entityType === 'household' ||
      entity.entityType === 'sole_prop' ||
      entity.entityType === 'llc_single';
    if (isSupportedTaxYear(year) && filesPersonal1040) {
      try {
        const filingStatusPref = await getPreference<string>(user.id, 'tax_filing_status', 'single');
        // Book profile → user preference → default
        const filingStatusRaw = entity.filingStatus ?? filingStatusPref;
        const filingStatus: FilingStatus = (FILING_STATUSES as readonly string[]).includes(filingStatusRaw)
          ? (filingStatusRaw as FilingStatus)
          : 'single';
        const birthday = await getPreference<string | null>(user.id, 'birthday', null);
        const withholding = await loadWithholdingCheckup({
          bookAccountGuids,
          bookGuid: roleResult.bookGuid,
          year,
          filingStatus,
          birthday: typeof birthday === 'string' ? birthday : null,
          filersAge65Plus: 0,
          annualize: false,
          priorYearTax: null,
          priorYearAgi: null,
        });
        if (withholding.checkup.hasData) {
          files[`withholding-${year}.txt`] = strToU8(withholdingToText(withholding));
          manifestFiles.push({ name: `withholding-${year}.txt`, description: 'Federal withholding vs projected liability snapshot' });
        }
      } catch (err) {
        console.error('tax-package: withholding failed', err);
        notes.push('Withholding checkup could not be generated (see server logs).');
      }
    }

    if (manifestFiles.length === 0) {
      return NextResponse.json(
        { error: `No tax data found for ${year}.`, notes },
        { status: 404 },
      );
    }

    files['README.txt'] = strToU8(buildManifest({
      year,
      generatedAt: new Date().toISOString(),
      files: manifestFiles,
      notes,
    }));

    const zipped = zipSync(files, { level: 6 });
    return new NextResponse(Buffer.from(zipped), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="tax-package-${year}.zip"`,
      },
    });
  } catch (error) {
    console.error('Error generating tax package:', error);
    return NextResponse.json({ error: 'Failed to generate tax package' }, { status: 500 });
  }
}
