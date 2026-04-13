import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
  getPayslip,
  updatePayslipLineItems,
  updatePayslipStatus,
  deletePayslip,
} from '@/lib/payslips';
import { getStorageBackend } from '@/lib/storage/storage-backend';
import type { PayslipLineItem, PayslipStatus } from '@/lib/types';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const payslipId = parseInt(id, 10);
    if (isNaN(payslipId)) {
      return NextResponse.json({ error: 'Invalid payslip ID' }, { status: 400 });
    }

    const payslip = await getPayslip(payslipId, bookGuid);
    if (!payslip) {
      return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
    }

    // Serve the PDF file if ?view=pdf
    const url = new URL(request.url);
    if (url.searchParams.get('view') === 'pdf' && payslip.storage_key) {
      const storage = await getStorageBackend();
      const buffer = await storage.get(payslip.storage_key);
      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="payslip-${payslipId}.pdf"`,
          'Cache-Control': 'private, max-age=86400',
        },
      });
    }

    return NextResponse.json(payslip);
  } catch (error) {
    console.error('Payslip fetch error:', error);
    return NextResponse.json({ error: 'Failed to fetch payslip' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const payslipId = parseInt(id, 10);
    if (isNaN(payslipId)) {
      return NextResponse.json({ error: 'Invalid payslip ID' }, { status: 400 });
    }

    const payslip = await getPayslip(payslipId, bookGuid);
    if (!payslip) {
      return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
    }

    const body = await request.json();
    const { line_items, status, employer_name } = body as {
      line_items?: PayslipLineItem[];
      status?: PayslipStatus;
      employer_name?: string;
    };

    if (line_items !== undefined) {
      await updatePayslipLineItems(payslipId, line_items);
    }

    if (status !== undefined) {
      await updatePayslipStatus(payslipId, status);
    }

    if (employer_name) {
      await updatePayslipStatus(payslipId, payslip.status as PayslipStatus, {
        employer_name: employer_name,
      });
    }

    const updated = await getPayslip(payslipId, bookGuid);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Payslip update error:', error);
    return NextResponse.json({ error: 'Failed to update payslip' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const roleResult = await requireRole('edit');
    if (roleResult instanceof NextResponse) return roleResult;
    const { bookGuid } = roleResult;

    const { id } = await params;
    const payslipId = parseInt(id, 10);
    if (isNaN(payslipId)) {
      return NextResponse.json({ error: 'Invalid payslip ID' }, { status: 400 });
    }

    const payslip = await getPayslip(payslipId, bookGuid);
    if (!payslip) {
      return NextResponse.json({ error: 'Payslip not found' }, { status: 404 });
    }

    if (payslip.status === 'posted') {
      return NextResponse.json(
        { error: 'Cannot delete a posted payslip' },
        { status: 400 }
      );
    }

    const storage = await getStorageBackend();
    if (payslip.storage_key) {
      try {
        await storage.delete(payslip.storage_key);
      } catch (err) {
        console.warn('Failed to delete payslip file:', err);
      }
    }
    if (payslip.thumbnail_key) {
      try {
        await storage.delete(payslip.thumbnail_key);
      } catch (err) {
        console.warn('Failed to delete payslip thumbnail:', err);
      }
    }

    await deletePayslip(payslipId, bookGuid);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Payslip delete error:', error);
    return NextResponse.json({ error: 'Failed to delete payslip' }, { status: 500 });
  }
}
