import { NextResponse } from 'next/server';
import { isOidcConfigured, getOidcProviderName } from '@/lib/oidc';

/**
 * GET /api/auth/providers
 *
 * Public endpoint the login page uses to decide which sign-in options to show.
 */
export async function GET() {
    return NextResponse.json({
        password: true,
        oidc: isOidcConfigured() ? { name: getOidcProviderName() } : null,
    });
}
