import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
import { SessionData, sessionOptions } from '@/lib/session-config';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public auth API routes, tokenized calendar feeds, and tokenized public
  // document endpoints (/api/public/invoice/[token] does its own token-based
  // authorization) -- no session required
  if (
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/calendar/') ||
    pathname.startsWith('/api/public/')
  ) {
    return NextResponse.next();
  }

  // For all protected routes, create the response first, then read session
  const response = NextResponse.next();
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  // Protected API routes -- return 401 if not authenticated
  if (pathname.startsWith('/api/')) {
    // API tokens: pass Bearer gcw_ requests through; requireRole() in the
    // route handler validates the token and enforces roles.
    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer gcw_')) {
      return NextResponse.next();
    }
    if (!session.isLoggedIn || !session.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await session.save();
    return response;
  }

  // Protected page routes -- redirect to login
  if (!session.isLoggedIn || !session.userId) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  await session.save();
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - / (landing page, public)
     * - /features/* (public marketing pages)
     * - /login (auth page)
     * - /api/auth/* (auth endpoints)
     * - /_next (Next.js internals)
     * - /icon.svg (favicon)
     * - Static files (.ico, .png, .jpg, .svg, etc.)
     *
     * The regex (?!$) ensures the root path "/" (empty capture after
     * stripping the leading "/") is excluded, keeping the landing page public.
     */
    '/((?!_next|login|features|share/|icon\\.svg|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css|js|json)$)(?!$).*)',
  ],
};
