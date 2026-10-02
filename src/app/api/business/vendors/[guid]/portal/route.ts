// src/app/api/business/vendors/[guid]/portal/route.ts
//
// Contractor portal links for one vendor in the active book.
// GET    → { links, emailConfigured, vendorEmail }
// POST   { expiresInDays?, label?, emailInvite? } → { link, url } — the URL
//        carries the secret and is returned ONLY here (it is stored hashed).
//        emailInvite sends it to the vendor's address when SMTP is set up.
// DELETE ?id= → revoke.

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { isEmailConfigured, sendEmail } from '@/lib/email';
import {
  createPortalLink,
  listPortalLinks,
  revokePortalLink,
  VendorPortalError,
} from '@/lib/business/vendor-portal.service';

type Params = { params: Promise<{ guid: string }> };

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof VendorPortalError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`${fallback}:`, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

async function vendorEmail(vendorGuid: string): Promise<{ email: string | null; name: string }> {
  const v = await prisma.vendors.findUnique({
    where: { guid: vendorGuid },
    select: { addr_email: true, name: true },
  });
  const email = v?.addr_email?.trim() || null;
  return { email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null, name: v?.name ?? 'there' };
}

function baseUrl(request: NextRequest): string {
  return (process.env.APP_BASE_URL || request.nextUrl.origin).replace(/\/$/, '');
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const role = await requireRole('readonly');
    if (role instanceof NextResponse) return role;
    const { guid } = await params;
    const links = await listPortalLinks(role.bookGuid, guid);
    const { email } = await vendorEmail(guid);
    return NextResponse.json({ links, emailConfigured: isEmailConfigured(), vendorEmail: email });
  } catch (error) {
    return errorResponse(error, 'Failed to load portal links');
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const role = await requireRole('edit');
    if (role instanceof NextResponse) return role;
    const { guid } = await params;
    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const { link, path } = await createPortalLink(
      role.bookGuid,
      guid,
      { expiresInDays: body.expiresInDays, label: typeof body.label === 'string' ? body.label : null },
      role.user.id,
    );
    const url = `${baseUrl(request)}${path}`;

    let emailed = false;
    if (body.emailInvite === true) {
      const { email, name } = await vendorEmail(guid);
      if (!email) throw new VendorPortalError('This vendor has no valid email address on file.');
      if (!isEmailConfigured()) throw new VendorPortalError('Email is not configured on this server.');
      const profile = await prisma.gnucash_web_entity_profiles.findUnique({
        where: { book_guid: role.bookGuid },
        select: { entity_name: true },
      });
      const payer = profile?.entity_name || 'your client';
      emailed = await sendEmail({
        to: email,
        subject: `Your payment history with ${payer}`,
        text: [
          `Hi ${name},`,
          '',
          `${payer} has shared your payment history with you: payments made, the invoices they covered, open bills, and your 1099 totals.`,
          '',
          url,
          '',
          `The link is private to you and expires on ${link.expiresAt.slice(0, 10)}. Do not forward it.`,
        ].join('\n'),
      });
    }
    return NextResponse.json({ link, url, emailed }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 'Failed to create portal link');
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const role = await requireRole('edit');
    if (role instanceof NextResponse) return role;
    await params;
    const id = Number(request.nextUrl.searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid link id' }, { status: 400 });
    }
    return NextResponse.json({ link: await revokePortalLink(role.bookGuid, id, role.user.id) });
  } catch (error) {
    return errorResponse(error, 'Failed to revoke portal link');
  }
}
