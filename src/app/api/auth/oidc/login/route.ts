import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import {
    isOidcConfigured,
    getOidcConfiguration,
    getRedirectUri,
    sealOidcTransaction,
    oidcClient,
    OIDC_TXN_COOKIE,
    OIDC_TXN_TTL_SECONDS,
} from '@/lib/oidc';

/**
 * GET /api/auth/oidc/login
 *
 * Starts the OIDC authorization code flow (PKCE S256 + state + nonce).
 * Returns 404 when OIDC is not configured (the login page uses this to decide
 * whether to show the SSO button).
 *
 * Query params:
 * - ?link=1     account-linking mode; requires an existing session.
 * - ?redirect=  path to land on after a successful login (default "/").
 */
export async function GET(request: NextRequest) {
    if (!isOidcConfigured()) {
        return NextResponse.json({ error: 'OIDC is not configured' }, { status: 404 });
    }

    const linkMode = request.nextUrl.searchParams.get('link') === '1';
    const redirectParam = request.nextUrl.searchParams.get('redirect') || '/';
    // Only allow same-site relative redirects
    const redirectTo = redirectParam.startsWith('/') && !redirectParam.startsWith('//')
        ? redirectParam
        : '/';

    let linkUserId: number | undefined;
    if (linkMode) {
        const session = await getSession();
        if (!session.isLoggedIn || !session.userId) {
            return NextResponse.redirect(new URL('/login?error=link_requires_login', request.url));
        }
        linkUserId = session.userId;
    }

    try {
        const config = await getOidcConfiguration();

        const codeVerifier = oidcClient.randomPKCECodeVerifier();
        const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier);
        const state = oidcClient.randomState();
        const nonce = oidcClient.randomNonce();

        const authorizationUrl = oidcClient.buildAuthorizationUrl(config, {
            redirect_uri: getRedirectUri(request.nextUrl.origin),
            scope: 'openid profile email',
            state,
            nonce,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        });

        const sealed = await sealOidcTransaction({
            state,
            nonce,
            codeVerifier,
            linkUserId,
            redirectTo,
        });

        const response = NextResponse.redirect(authorizationUrl);
        response.cookies.set(OIDC_TXN_COOKIE, sealed, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: OIDC_TXN_TTL_SECONDS,
            path: '/',
        });
        return response;
    } catch (error) {
        console.error('OIDC login initiation failed:', error);
        const target = linkMode ? '/profile?oidc=error' : '/login?error=oidc_unavailable';
        return NextResponse.redirect(new URL(target, request.url));
    }
}
