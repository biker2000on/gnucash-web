import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import prisma from '@/lib/prisma';
import { isTaxCategory, type TaxCategory } from '@/lib/tax/types';
import { suggestTaxMappings, type SuggestableAccount } from '@/lib/tax/suggest';

interface AccountRow {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
  hidden: number | null;
  placeholder: number | null;
}

/**
 * GET /api/tax/mappings
 * Returns all tax mappings for the active book, the candidate accounts,
 * and auto-suggestions for unmapped accounts.
 */
export async function GET() {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const bookAccountGuids = await getBookAccountGuids();

    const [mappingRows, accountRows, retirementPrefs] = await Promise.all([
      prisma.gnucash_web_tax_mappings.findMany({
        where: { account_guid: { in: bookAccountGuids } },
      }),
      prisma.$queryRaw<AccountRow[]>`
        SELECT guid, name, fullname, account_type, hidden, placeholder
        FROM account_hierarchy
        WHERE guid = ANY(${bookAccountGuids})
          AND account_type NOT IN ('ROOT', 'EQUITY')
        ORDER BY fullname
      `,
      prisma.gnucash_web_account_preferences.findMany({
        where: { account_guid: { in: bookAccountGuids }, is_retirement: true },
        select: { account_guid: true, retirement_account_type: true },
      }),
    ]);

    const retirementTypeMap = new Map(
      retirementPrefs.map(p => [p.account_guid, p.retirement_account_type]),
    );

    const mappings: Record<string, TaxCategory> = {};
    for (const row of mappingRows) {
      if (isTaxCategory(row.tax_category)) mappings[row.account_guid] = row.tax_category;
    }

    const accounts = accountRows.map(a => ({
      guid: a.guid,
      name: a.name,
      fullname: a.fullname,
      accountType: a.account_type,
      hidden: a.hidden === 1,
      placeholder: a.placeholder === 1,
      retirementAccountType: retirementTypeMap.get(a.guid) ?? null,
    }));

    const suggestable: SuggestableAccount[] = accounts
      .filter(a => !a.placeholder)
      .map(a => ({
        guid: a.guid,
        name: a.name,
        fullname: a.fullname,
        accountType: a.accountType,
        retirementAccountType: a.retirementAccountType,
      }));
    const suggestions = suggestTaxMappings(suggestable, mappings);

    return NextResponse.json({ mappings, accounts, suggestions });
  } catch (error) {
    console.error('Error fetching tax mappings:', error);
    return NextResponse.json({ error: 'Failed to fetch tax mappings' }, { status: 500 });
  }
}

/**
 * PUT /api/tax/mappings
 * Bulk upsert/delete tax mappings.
 * Body: { mappings: Array<{ accountGuid: string, taxCategory: string | null }> }
 * taxCategory null removes the mapping.
 */
export async function PUT(request: NextRequest) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json();
    const entries: Array<{ accountGuid?: unknown; taxCategory?: unknown }> = body?.mappings;
    if (!Array.isArray(entries)) {
      return NextResponse.json(
        { error: 'Body must include a "mappings" array' },
        { status: 400 },
      );
    }

    const bookAccountGuids = new Set(await getBookAccountGuids());

    const upserts: Array<{ accountGuid: string; taxCategory: TaxCategory }> = [];
    const deletes: string[] = [];
    for (const entry of entries) {
      const guid = entry.accountGuid;
      if (typeof guid !== 'string' || guid.length !== 32 || !bookAccountGuids.has(guid)) {
        return NextResponse.json(
          { error: `Invalid or out-of-book account guid: ${String(guid)}` },
          { status: 400 },
        );
      }
      if (entry.taxCategory === null) {
        deletes.push(guid);
      } else if (typeof entry.taxCategory === 'string' && isTaxCategory(entry.taxCategory)) {
        upserts.push({ accountGuid: guid, taxCategory: entry.taxCategory });
      } else {
        return NextResponse.json(
          { error: `Invalid tax category: ${String(entry.taxCategory)}` },
          { status: 400 },
        );
      }
    }

    await prisma.$transaction([
      ...(deletes.length > 0
        ? [prisma.gnucash_web_tax_mappings.deleteMany({ where: { account_guid: { in: deletes } } })]
        : []),
      ...upserts.map(u =>
        prisma.gnucash_web_tax_mappings.upsert({
          where: { account_guid: u.accountGuid },
          create: { account_guid: u.accountGuid, tax_category: u.taxCategory },
          update: { tax_category: u.taxCategory, updated_at: new Date() },
        }),
      ),
    ]);

    return NextResponse.json({ success: true, upserted: upserts.length, deleted: deletes.length });
  } catch (error) {
    console.error('Error saving tax mappings:', error);
    return NextResponse.json({ error: 'Failed to save tax mappings' }, { status: 500 });
  }
}
