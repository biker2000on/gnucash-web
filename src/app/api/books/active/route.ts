import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';

/**
 * GET /api/books/active
 * Return the active book GUID from session.
 */
export async function GET() {
    try {
        const session = await getSession();

        let activeBookGuid = session.activeBookGuid || null;

        // Validate the active book still exists
        if (activeBookGuid) {
            const exists = await prisma.books.findUnique({
                where: { guid: activeBookGuid },
                select: { guid: true },
            });
            if (!exists) {
                activeBookGuid = null;
            }
        }

        // Fall back to the first book
        if (!activeBookGuid) {
            const firstBook = await prisma.books.findFirst({
                select: { guid: true },
            });
            if (firstBook) {
                activeBookGuid = firstBook.guid;
                session.activeBookGuid = activeBookGuid;
                await session.save();
            }
        }

        return NextResponse.json({ activeBookGuid });
    } catch (error) {
        console.error('Error getting active book:', error);
        return NextResponse.json({ error: 'Failed to get active book' }, { status: 500 });
    }
}

/**
 * PUT /api/books/active
 * Set the active book GUID in session.
 */
export async function PUT(request: NextRequest) {
    try {
        const body = await request.json();
        const { bookGuid } = body;

        if (!bookGuid || typeof bookGuid !== 'string') {
            return NextResponse.json(
                { error: 'bookGuid is required' },
                { status: 400 }
            );
        }

        // Validate the book exists
        const book = await prisma.books.findUnique({
            where: { guid: bookGuid },
            select: { guid: true },
        });

        if (!book) {
            return NextResponse.json(
                { error: 'Book not found' },
                { status: 404 }
            );
        }

        const session = await getSession();
        session.activeBookGuid = bookGuid;
        await session.save();

        return NextResponse.json({ activeBookGuid: bookGuid });
    } catch (error) {
        console.error('Error setting active book:', error);
        return NextResponse.json({ error: 'Failed to set active book' }, { status: 500 });
    }
}
