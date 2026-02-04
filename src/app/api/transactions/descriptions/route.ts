import { NextRequest, NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { Prisma } from '@prisma/client';

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
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q') || '';
  const accountGuid = searchParams.get('account_guid');
  const limit = parseInt(searchParams.get('limit') || '10');

  if (query.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    // Build where clause with optional account filter
    const whereClause: Prisma.transactionsWhereInput = {
      description: {
        contains: query,
        mode: 'insensitive'
      },
      ...(accountGuid && {
        splits: {
          some: {
            account_guid: accountGuid
          }
        }
      })
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
