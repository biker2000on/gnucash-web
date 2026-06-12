import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { createSession } from '@/lib/auth';
import { grantRole } from '@/lib/services/permission.service';
import {
    appUrl,
    isOidcConfigured,
    getOidcConfiguration,
    getOidcIssuer,
    getRedirectUri,
    unsealOidcTransaction,
    oidcClient,
    OIDC_TXN_COOKIE,
} from '@/lib/oidc';
import {
    resolveOidcUser,
    hasVerifiedEmail,
    type OidcClaims,
    type OidcUserCandidate,
} from '@/lib/oidc-resolve';

const USER_CANDIDATE_SELECT = {
    id: true,
    username: true,
    email: true,
    oidc_subject: true,
    oidc_issuer: true,
    password_hash: true,
} as const;

type DbUser = {
    id: number;
    username: string;
    email: string | null;
    oidc_subject: string | null;
    oidc_issuer: string | null;
    password_hash: string | null;
};

function toCandidate(user: DbUser | null): OidcUserCandidate | null {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        email: user.email,
        oidc_subject: user.oidc_subject,
        oidc_issuer: user.oidc_issuer,
        hasPassword: Boolean(user.password_hash),
    };
}

function loginRedirect(request: NextRequest, params: Record<string, string>) {
    const url = appUrl('/login', request.url);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return NextResponse.redirect(url);
}

/** Is this email free to store on the given user (unique across other users)? */
async function emailIsFree(email: string, forUserId?: number): Promise<boolean> {
    const owner = await prisma.gnucash_web_users.findFirst({
        where: { email },
        select: { id: true },
    });
    return !owner || owner.id === forUserId;
}

/** Profile fields refreshed from the provider on every login. */
function profileData(claims: OidcClaims) {
    return {
        display_name: claims.name || null,
        avatar_url: claims.picture || null,
    };
}

/**
 * GET /api/auth/oidc/callback
 *
 * Completes the authorization code flow: verifies state/nonce/PKCE, validates
 * the ID token, fetches userinfo, then resolves the identity to a local user
 * (login, auto-link by verified email, link mode, pending, or create).
 */
export async function GET(request: NextRequest) {
    if (!isOidcConfigured()) {
        return NextResponse.json({ error: 'OIDC is not configured' }, { status: 404 });
    }

    // --- Recover and clear the transaction cookie ---
    const sealed = request.cookies.get(OIDC_TXN_COOKIE)?.value;
    const txn = sealed ? await unsealOidcTransaction(sealed) : null;

    const clearTxnCookie = (response: NextResponse) => {
        response.cookies.set(OIDC_TXN_COOKIE, '', { maxAge: 0, path: '/' });
        return response;
    };

    if (!txn) {
        return clearTxnCookie(loginRedirect(request, { error: 'oidc_state' }));
    }

    // Provider-reported errors (user cancelled, etc.)
    const providerError = request.nextUrl.searchParams.get('error');
    if (providerError) {
        const target = txn.linkUserId
            ? NextResponse.redirect(appUrl('/profile?oidc=cancelled', request.url))
            : loginRedirect(request, { error: 'oidc_cancelled' });
        return clearTxnCookie(target);
    }

    let claims: OidcClaims;
    try {
        const config = await getOidcConfiguration();

        // Reconstruct the callback URL on the registered redirect URI so the
        // library's redirect_uri check passes even behind a reverse proxy.
        const currentUrl = new URL(getRedirectUri(request.nextUrl.origin));
        currentUrl.search = request.nextUrl.search;

        const tokens = await oidcClient.authorizationCodeGrant(config, currentUrl, {
            pkceCodeVerifier: txn.codeVerifier,
            expectedState: txn.state,
            expectedNonce: txn.nonce,
            idTokenExpected: true,
        });

        const idClaims = tokens.claims();
        if (!idClaims?.sub) {
            throw new Error('ID token missing subject');
        }

        // Userinfo is the authoritative profile source; sub is cross-checked.
        const userinfo = await oidcClient.fetchUserInfo(config, tokens.access_token, idClaims.sub);

        claims = {
            sub: idClaims.sub,
            issuer: getOidcIssuer(),
            email: (userinfo.email || (idClaims.email as string | undefined)) ?? undefined,
            emailVerified:
                (userinfo.email_verified ?? (idClaims.email_verified as boolean | undefined)) === true,
            preferredUsername:
                (userinfo.preferred_username ||
                    (idClaims.preferred_username as string | undefined)) ?? undefined,
            name: (userinfo.name || (idClaims.name as string | undefined)) ?? undefined,
            picture: (userinfo.picture || (idClaims.picture as string | undefined)) ?? undefined,
        };
    } catch (error) {
        console.error('OIDC callback validation failed:', error);
        const target = txn.linkUserId
            ? NextResponse.redirect(appUrl('/profile?oidc=error', request.url))
            : loginRedirect(request, { error: 'oidc_failed' });
        return clearTxnCookie(target);
    }

    try {
        // --- Gather lookup inputs for the pure resolver ---
        const userBySubject = toCandidate(
            await prisma.gnucash_web_users.findFirst({
                where: { oidc_issuer: claims.issuer, oidc_subject: claims.sub },
                select: USER_CANDIDATE_SELECT,
            })
        );

        const userByEmail = hasVerifiedEmail(claims)
            ? toCandidate(
                  await prisma.gnucash_web_users.findFirst({
                      where: { email: claims.email },
                      select: USER_CANDIDATE_SELECT,
                  })
              )
            : null;

        const userByUsername = claims.preferredUsername
            ? toCandidate(
                  await prisma.gnucash_web_users.findUnique({
                      where: { username: claims.preferredUsername },
                      select: USER_CANDIDATE_SELECT,
                  })
              )
            : null;

        const linkUser = txn.linkUserId
            ? toCandidate(
                  await prisma.gnucash_web_users.findUnique({
                      where: { id: txn.linkUserId },
                      select: USER_CANDIDATE_SELECT,
                  })
              )
            : null;

        if (txn.linkUserId && !linkUser) {
            return clearTxnCookie(loginRedirect(request, { error: 'link_requires_login' }));
        }

        // Usernames needed for de-duping a potential new username
        const allUsernames = await prisma.gnucash_web_users.findMany({
            select: { username: true },
        });
        const takenUsernames = new Set(allUsernames.map((u) => u.username));

        const result = resolveOidcUser({
            claims,
            userBySubject,
            userByEmail,
            userByUsername,
            takenUsernames,
            linkUser,
        });

        const verifiedEmail = hasVerifiedEmail(claims) ? claims.email! : null;

        switch (result.action) {
            case 'link': {
                await prisma.gnucash_web_users.update({
                    where: { id: result.userId },
                    data: {
                        oidc_subject: claims.sub,
                        oidc_issuer: claims.issuer,
                        auth_method: linkUser?.hasPassword ? 'both' : 'oidc',
                        ...(verifiedEmail && (await emailIsFree(verifiedEmail, result.userId))
                            ? { email: verifiedEmail }
                            : {}),
                        ...profileData(claims),
                    },
                });
                return clearTxnCookie(
                    NextResponse.redirect(appUrl('/profile?oidc=linked', request.url))
                );
            }

            case 'link-already':
                return clearTxnCookie(
                    NextResponse.redirect(appUrl('/profile?oidc=already_linked', request.url))
                );

            case 'link-conflict':
                return clearTxnCookie(
                    NextResponse.redirect(appUrl('/profile?oidc=conflict', request.url))
                );

            case 'login': {
                const user = await prisma.gnucash_web_users.update({
                    where: { id: result.userId },
                    data: {
                        last_login: new Date(),
                        ...(verifiedEmail && (await emailIsFree(verifiedEmail, result.userId))
                            ? { email: verifiedEmail }
                            : {}),
                        ...profileData(claims),
                    },
                    select: { id: true, username: true },
                });
                await createSession(user.id, user.username);
                return clearTxnCookie(
                    NextResponse.redirect(appUrl(txn.redirectTo || '/', request.url))
                );
            }

            case 'auto-link': {
                // Migration path: manual account with a matching verified email.
                const user = await prisma.gnucash_web_users.update({
                    where: { id: result.userId },
                    data: {
                        oidc_subject: claims.sub,
                        oidc_issuer: claims.issuer,
                        auth_method: userByEmail?.hasPassword ? 'both' : 'oidc',
                        last_login: new Date(),
                        ...profileData(claims),
                    },
                    select: { id: true, username: true },
                });
                await createSession(user.id, user.username);
                return clearTxnCookie(
                    NextResponse.redirect(appUrl(txn.redirectTo || '/', request.url))
                );
            }

            case 'pending':
                // A local account with this username exists but cannot be safely
                // matched. Ask the user to log in with their password and link
                // from the profile page instead (prevents username squatting).
                return clearTxnCookie(
                    loginRedirect(request, { oidc_pending: '1', username: result.username })
                );

            case 'create': {
                const user = await prisma.gnucash_web_users.create({
                    data: {
                        username: result.username,
                        password_hash: null,
                        auth_method: 'oidc',
                        oidc_subject: claims.sub,
                        oidc_issuer: claims.issuer,
                        email:
                            verifiedEmail && (await emailIsFree(verifiedEmail))
                                ? verifiedEmail
                                : null,
                        last_login: new Date(),
                        ...profileData(claims),
                    },
                    select: { id: true, username: true },
                });

                // New OIDC users get readonly access to all existing books.
                try {
                    const books = await prisma.books.findMany({ select: { guid: true } });
                    for (const book of books) {
                        await grantRole(user.id, book.guid, 'readonly', user.id);
                    }
                } catch (rbacError) {
                    console.error('Failed to bootstrap RBAC for new OIDC user:', rbacError);
                }

                await createSession(user.id, user.username);
                return clearTxnCookie(
                    NextResponse.redirect(appUrl(txn.redirectTo || '/', request.url))
                );
            }
        }
    } catch (error) {
        console.error('OIDC callback failed:', error);
        const target = txn.linkUserId
            ? NextResponse.redirect(appUrl('/profile?oidc=error', request.url))
            : loginRedirect(request, { error: 'oidc_failed' });
        return clearTxnCookie(target);
    }
}
