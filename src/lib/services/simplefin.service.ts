/**
 * SimpleFin Bridge API Client
 *
 * Handles communication with SimpleFin Bridge for bank transaction imports.
 * Provides token claiming, account fetching, and access URL encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

// --- Encryption ---

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
}

export function encryptAccessUrl(url: string): string {
  const secret = process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_12345';
  const salt = randomBytes(16);
  const key = deriveKey(secret, salt);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(url, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  // Format: salt:iv:authTag:encrypted
  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptAccessUrl(encrypted: string): string {
  const secret = process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_12345';
  const [saltHex, ivHex, authTagHex, data] = encrypted.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const key = deriveKey(secret, salt);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- Errors ---

export class SimpleFinAccessRevokedError extends Error {
  constructor() {
    super('SimpleFin access has been revoked. Please reconnect.');
    this.name = 'SimpleFinAccessRevokedError';
  }
}

export class SimpleFinError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SimpleFinError';
    this.status = status;
  }
}

// --- SimpleFin API types ---

export interface SimpleFinTransaction {
  id: string;
  posted: number; // Unix timestamp
  amount: string; // e.g. "-45.67"
  description: string;
  payee?: string;
  memo?: string;
  pending?: boolean;
}

export interface SimpleFinHolding {
  id?: string;
  created?: number;
  currency?: string;
  cost_basis?: string;
  description?: string;
  market_value?: string;
  purchase_price?: string;
  shares?: string;
  symbol?: string;
}

export interface SimpleFinAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  'available-balance'?: string;
  org?: {
    name?: string;
    domain?: string;
    url?: string;
    'sfin-url'?: string;
  };
  transactions?: SimpleFinTransaction[];
  holdings?: SimpleFinHolding[];
}

export interface SimpleFinAccountSet {
  errors: string[];
  accounts: SimpleFinAccount[];
}

// --- API Client ---

/**
 * Claim a SimpleFin setup token.
 * Decodes the base64 token to get a claim URL, then POSTs to exchange for an access URL.
 */
export async function claimSetupToken(token: string): Promise<string> {
  // Decode base64 setup token to get the claim URL
  const claimUrl = Buffer.from(token.trim(), 'base64').toString('utf8');

  if (!claimUrl.startsWith('http')) {
    throw new SimpleFinError('Invalid setup token', 400);
  }

  // POST to claim URL (empty body) to exchange for access URL
  const response = await fetch(claimUrl, {
    method: 'POST',
    headers: { 'Content-Length': '0' },
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new SimpleFinError('Setup token has already been claimed or is invalid', 403);
    }
    throw new SimpleFinError(`Failed to claim token: ${response.status} ${response.statusText}`, response.status);
  }

  const accessUrl = await response.text();

  if (!accessUrl || !accessUrl.startsWith('http')) {
    throw new SimpleFinError('Invalid access URL received from SimpleFin', 400);
  }

  return accessUrl.trim();
}

/**
 * Fetch accounts (and optionally transactions) from SimpleFin.
 * The access URL contains embedded Basic Auth credentials.
 */
export async function fetchAccounts(
  accessUrl: string,
  startDate?: number,
  endDate?: number
): Promise<SimpleFinAccountSet> {
  // Parse the access URL to extract auth and build the request URL
  const url = new URL(accessUrl);
  const auth = Buffer.from(`${url.username}:${url.password}`).toString('base64');

  // Build the accounts endpoint (strip auth from URL)
  const accountsUrl = new URL('/simplefin/accounts', `${url.protocol}//${url.host}`);
  if (startDate) accountsUrl.searchParams.set('start-date', startDate.toString());
  if (endDate) accountsUrl.searchParams.set('end-date', endDate.toString());

  const response = await fetch(accountsUrl.toString(), {
    headers: {
      'Authorization': `Basic ${auth}`,
    },
    signal: AbortSignal.timeout(30000), // 30 second timeout
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new SimpleFinAccessRevokedError();
    }
    throw new SimpleFinError(`SimpleFin API error: ${response.status}`, response.status);
  }

  const data: SimpleFinAccountSet = await response.json();
  return data;
}

/**
 * Fetch accounts with 60-day chunking for date ranges > 60 days.
 * SimpleFin limits the start-date to end-date range to 60 days.
 */
export async function fetchAccountsChunked(
  accessUrl: string,
  startDate: Date,
  endDate: Date
): Promise<SimpleFinAccountSet> {
  const chunks = Array.from(dateChunks(startDate, endDate));

  if (chunks.length === 0) {
    return { errors: [], accounts: [] };
  }

  // For single chunk, just fetch directly
  if (chunks.length === 1) {
    return fetchAccounts(accessUrl, chunks[0].start, chunks[0].end);
  }

  // For multiple chunks, merge results
  const allAccounts = new Map<string, SimpleFinAccount>();
  const allErrors: string[] = [];

  for (const chunk of chunks) {
    const result = await fetchAccounts(accessUrl, chunk.start, chunk.end);
    allErrors.push(...result.errors);

    for (const account of result.accounts) {
      const existing = allAccounts.get(account.id);
      if (existing) {
        // Merge transactions
        const existingTxIds = new Set(existing.transactions?.map(t => t.id) || []);
        const newTxns = account.transactions?.filter(t => !existingTxIds.has(t.id)) || [];
        existing.transactions = [...(existing.transactions || []), ...newTxns];
        // Update balance to latest
        existing.balance = account.balance;
        existing['available-balance'] = account['available-balance'];
        // Preserve holdings (take latest non-empty)
        if (account.holdings && account.holdings.length > 0) {
          existing.holdings = account.holdings;
        }
      } else {
        allAccounts.set(account.id, { ...account });
      }
    }
  }

  return {
    errors: allErrors,
    accounts: Array.from(allAccounts.values()),
  };
}

/**
 * Generate date chunks of up to maxDays each.
 */
export function* dateChunks(
  startDate: Date,
  endDate: Date,
  maxDays = 60
): Generator<{ start: number; end: number }> {
  const msPerDay = 86400000;
  let current = startDate.getTime();
  const end = endDate.getTime();

  while (current < end) {
    const chunkEnd = Math.min(current + maxDays * msPerDay, end);
    yield {
      start: Math.floor(current / 1000),
      end: Math.floor(chunkEnd / 1000),
    };
    current = chunkEnd;
  }
}
