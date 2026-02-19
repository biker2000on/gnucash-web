import { NextRequest, NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export interface TransactionSuggestion {
  description: string;
  lastUsed: string;
  splits: Array<{
    accountGuid: string;
    accountName: string;
    amount: number;
  }>;
}

export async function GET(request: NextRequest) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;

  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q') || '';
  const accountGuid = searchParams.get('account_guid');
  const limit = parseInt(searchParams.get('limit') || '10');

  if (query.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    // Get book account GUIDs for scoping
    const bookAccountGuids = await getBookAccountGuids();

    // Build where clause with book scoping and optional account filter
    const whereClause: Prisma.transactionsWhereInput = {
      description: {
        contains: query,
        mode: 'insensitive'
      },
      splits: {
        some: {
          account_guid: accountGuid ? accountGuid : { in: bookAccountGuids },
        }
      }
    };

    // Get unique descriptions with most recent post_date
    const transactions = await prisma.transactions.findMany({
      where: whereClause,
      orderBy: {
        post_date: 'desc'
      },
      take: limit * 2, // Get extra to handle duplicates
      distinct: ['description'],
      include: {
        splits: {
          include: {
            account: true
          }
        }
      }
    });

    // Process transactions into suggestions
    const suggestions: TransactionSuggestion[] = [];
    const seenDescriptions = new Set<string>();

    for (const tx of transactions) {
      if (!tx.description || !tx.post_date || seenDescriptions.has(tx.description) || suggestions.length >= limit) {
        continue;
      }
      seenDescriptions.add(tx.description);

      suggestions.push({
        description: tx.description,
        lastUsed: tx.post_date.toISOString(),
        splits: tx.splits.map(split => ({
          accountGuid: split.account_guid,
          accountName: split.account.name,
          amount: parseFloat(toDecimal(split.value_num, split.value_denom))
        }))
      });
    }

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error('Error fetching descriptions:', error);
    return NextResponse.json({ error: 'Failed to fetch suggestions' }, { status: 500 });
  }
}
