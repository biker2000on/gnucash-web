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
import type { TimeProject } from '@/lib/timesheet';

// GnuCash owner type 2 = customer (matches the invoice engine).
const OWNER_TYPE_CUSTOMER = 2;

/** GET /api/business/time/projects -> { projects: TimeProject[] } */
export async function GET() {
  try {
    const roleResult = await requireTimesheetRole('read');
    if (roleResult instanceof NextResponse) return roleResult;

    const [customers, jobs] = await Promise.all([
      prisma.customers.findMany({
        where: { active: 1 },
        select: { guid: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.jobs.findMany({
        where: { active: 1, owner_type: OWNER_TYPE_CUSTOMER, owner_guid: { not: null } },
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
