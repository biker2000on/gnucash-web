/**
 * OIDC (OpenID Connect) integration — optional SSO via an external provider
 * (e.g. Pocket ID). Entirely disabled unless OIDC_ISSUER, OIDC_CLIENT_ID and
 * OIDC_CLIENT_SECRET are set.
 *
 * Uses openid-client v6: discovery is performed once and cached at module level.
 */

import * as client from 'openid-client';
import { sealData, unsealData } from 'iron-session';
import { sessionOptions } from './session-config';

export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';
export const OIDC_TXN_COOKIE = 'gnucash_web_oidc_txn';
export const OIDC_TXN_TTL_SECONDS = 600; // 10 minutes to complete the flow

/** True when all required OIDC env vars are present. */
export function isOidcConfigured(): boolean {
    return Boolean(
        process.env.OIDC_ISSUER &&
        process.env.OIDC_CLIENT_ID &&
        process.env.OIDC_CLIENT_SECRET
    );
}

/** Display name for the provider button ("Sign in with {name}"). */
export function getOidcProviderName(): string {
    return process.env.OIDC_PROVIDER_NAME || 'SSO';
}

export function getOidcIssuer(): string {
    return process.env.OIDC_ISSUER || '';
}

// Module-level discovery cache. The promise is cached (not the resolved value)
// so concurrent first requests share one discovery round-trip. On failure the
// cache is cleared so the next request retries.
let configPromise: Promise<client.Configuration> | null = null;

export function getOidcConfiguration(): Promise<client.Configuration> {
    if (!isOidcConfigured()) {
        return Promise.reject(new Error('OIDC is not configured'));
    }
    if (!configPromise) {
        configPromise = client
            .discovery(
                new URL(process.env.OIDC_ISSUER!),
                process.env.OIDC_CLIENT_ID!,
                process.env.OIDC_CLIENT_SECRET!
            )
            .catch((err) => {
                configPromise = null;
                throw err;
            });
    }
    return configPromise;
}

/**
 * Derive the redirect URI. Prefers NEXTAUTH_URL (set in production),
 * falling back to the origin of the incoming request.
 */
export function getRedirectUri(requestOrigin: string): string {
    const base = process.env.NEXTAUTH_URL || requestOrigin;
    return new URL(OIDC_CALLBACK_PATH, base).toString();
}

/** Transaction state carried across the redirect in a sealed cookie. */
export interface OidcTransaction {
    state: string;
    nonce: string;
    codeVerifier: string;
    /** Account-linking mode: the id of the already-logged-in user. */
    linkUserId?: number;
    /** Where to send the user after a successful login. */
    redirectTo?: string;
}

export async function sealOidcTransaction(txn: OidcTransaction): Promise<string> {
    return sealData(txn, {
        password: sessionOptions.password as string,
        ttl: OIDC_TXN_TTL_SECONDS,
    });
}

export async function unsealOidcTransaction(sealed: string): Promise<OidcTransaction | null> {
    try {
        const data = await unsealData<OidcTransaction>(sealed, {
            password: sessionOptions.password as string,
            ttl: OIDC_TXN_TTL_SECONDS,
        });
        if (!data || typeof data.state !== 'string' || typeof data.codeVerifier !== 'string') {
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

export { client as oidcClient };
