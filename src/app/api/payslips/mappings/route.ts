import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getMappingsForEmployer, upsertMapping } from '@/lib/payslips';

export async function GET(request: Request) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { searchParams } = new URL(request.url);
    const employer = searchParams.get('employer');

    if (!employer) {
      return NextResponse.json({ error: 'employer query param is required' }, { status: 400 });
    }

    const mappings = await getMappingsForEmployer(bookGuid, employer);
    return NextResponse.json(mappings);
  } catch (error) {
    console.error('Mappings fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch mappings' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const body = await request.json();
    const { employer_name, mappings } = body as {
      employer_name: string;
      mappings: Array<{
        normalized_label: string;
        line_item_category: string;
        account_guid: string;
      }>;
    };

    if (!employer_name || !Array.isArray(mappings)) {
      return NextResponse.json(
        { error: 'employer_name and mappings array are required' },
        { status: 400 }
      );
    }

    await Promise.all(
      mappings.map(m =>
        upsertMapping({
          book_guid: bookGuid,
          employer_name,
          normalized_label: m.normalized_label,
          line_item_category: m.line_item_category,
          account_guid: m.account_guid,
        })
      )
    );

    const updated = await getMappingsForEmployer(bookGuid, employer_name);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Mappings upsert error:', error);
    return NextResponse.json({ error: 'Failed to update mappings' }, { status: 500 });
  }
}
