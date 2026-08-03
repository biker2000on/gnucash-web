// src/app/api/business/time/projects/route.ts
//
// "Projects" for the timesheet UI: every active customer, plus every active
// customer/job pair, flattened into selectable rows. This lives under the
// time API (requireTimesheetRole) so restricted timekeepers can pick what to
// log time against WITHOUT access to the financial customer/job endpoints.
// Names only — no rates, balances, or addresses.

import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireTimesheetRole } from '@/lib/auth';
import { listOwnedEntityGuids } from '@/lib/business/entity-ownership';
import type { TimeProject } from '@/lib/timesheet';

// GnuCash owner type 2 = customer (matches the invoice engine).
const OWNER_TYPE_CUSTOMER = 2;

/** GET /api/business/time/projects -> { projects: TimeProject[] } */
export async function GET() {
  try {
    const roleResult = await requireTimesheetRole('read');
    if (roleResult instanceof NextResponse) return roleResult;

    // The native customer/job tables carry no book column, so scope through
    // the ownership table. This endpoint is reachable by restricted
    // timekeepers, which makes an unscoped read the widest-audience leak of
    // the set — book B's customer names would show in book A's picker.
    const [ownedCustomers, ownedJobs] = await Promise.all([
      listOwnedEntityGuids('customer', roleResult.bookGuid),
      listOwnedEntityGuids('job', roleResult.bookGuid),
    ]);
    if (ownedCustomers.length === 0 && ownedJobs.length === 0) {
      return NextResponse.json({ projects: [] });
    }

    const [customers, jobs] = await Promise.all([
      ownedCustomers.length === 0 ? [] : prisma.customers.findMany({
        where: { active: 1, guid: { in: ownedCustomers } },
        select: { guid: true, name: true },
        orderBy: { name: 'asc' },
      }),
      ownedJobs.length === 0 ? [] : prisma.jobs.findMany({
        where: {
          active: 1,
          owner_type: OWNER_TYPE_CUSTOMER,
          owner_guid: { not: null },
          guid: { in: ownedJobs },
        },
        select: { guid: true, name: true, owner_guid: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const customerNames = new Map(customers.map((c) => [c.guid, c.name]));
    const projects: TimeProject[] = [];

    for (const c of customers) {
      projects.push({
        key: `${c.guid}:`,
        customerGuid: c.guid,
        customerName: c.name,
        jobGuid: null,
        jobName: null,
        label: c.name,
      });
      const customerJobs = jobs.filter((j) => j.owner_guid === c.guid);
      for (const j of customerJobs) {
        projects.push({
          key: `${c.guid}:${j.guid}`,
          customerGuid: c.guid,
          customerName: c.name,
          jobGuid: j.guid,
          jobName: j.name,
          label: `${c.name} — ${j.name}`,
        });
      }
    }

    // Jobs whose customer is inactive still appear (existing entries may
    // reference them) as long as the customer row exists.
    for (const j of jobs) {
      if (!j.owner_guid || customerNames.has(j.owner_guid)) continue;
      // An inactive owner is still only visible if this book owns it.
      if (!ownedCustomers.includes(j.owner_guid)) continue;
      const owner = await prisma.customers.findUnique({
        where: { guid: j.owner_guid },
        select: { guid: true, name: true },
      });
      if (!owner) continue;
      customerNames.set(owner.guid, owner.name);
      projects.push({
        key: `${owner.guid}:${j.guid}`,
        customerGuid: owner.guid,
        customerName: owner.name,
        jobGuid: j.guid,
        jobName: j.name,
        label: `${owner.name} — ${j.name}`,
      });
    }

    return NextResponse.json({ projects });
  } catch (error) {
    console.error('Time projects API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
