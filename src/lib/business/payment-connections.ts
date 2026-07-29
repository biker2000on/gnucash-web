import { query } from '@/lib/db';
import { decryptSecret, encryptSecret } from '@/lib/secure-config';
import { logAudit } from '@/lib/services/audit.service';

export interface PaymentConnectionView {
  provider: 'stripe';
  enabled: boolean;
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  transferAccountGuid: string | null;
  feeAccountGuid: string | null;
  updatedAt: string | null;
}

export interface StripeConnection {
  bookGuid: string;
  secretKey: string;
  webhookSecret: string;
  transferAccountGuid: string;
  feeAccountGuid: string | null;
}

interface ConnectionRow {
  book_guid: string;
  provider: 'stripe';
  secret_key_encrypted: string | null;
  webhook_secret_encrypted: string | null;
  transfer_account_guid: string | null;
  fee_account_guid: string | null;
  enabled: boolean;
  updated_at: Date | string;
}

function view(row: ConnectionRow | undefined): PaymentConnectionView {
  return {
    provider: 'stripe',
    enabled: row?.enabled ?? false,
    hasSecretKey: Boolean(row?.secret_key_encrypted),
    hasWebhookSecret: Boolean(row?.webhook_secret_encrypted),
    transferAccountGuid: row?.transfer_account_guid ?? null,
    feeAccountGuid: row?.fee_account_guid ?? null,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function getPaymentConnectionView(bookGuid: string): Promise<PaymentConnectionView> {
  const result = await query(
    'SELECT * FROM gnucash_web_payment_connections WHERE book_guid = $1',
    [bookGuid],
  );
  return view(result.rows[0] as ConnectionRow | undefined);
}

export async function savePaymentConnection(input: {
  bookGuid: string;
  userId: number;
  secretKey?: string | null;
  webhookSecret?: string | null;
  transferAccountGuid?: string | null;
  feeAccountGuid?: string | null;
  enabled: boolean;
}): Promise<PaymentConnectionView> {
  const existing = await query(
    'SELECT * FROM gnucash_web_payment_connections WHERE book_guid = $1',
    [input.bookGuid],
  );
  const row = existing.rows[0] as ConnectionRow | undefined;
  const secretEncrypted = input.secretKey?.trim()
    ? encryptSecret(input.secretKey.trim())
    : row?.secret_key_encrypted ?? null;
  const webhookEncrypted = input.webhookSecret?.trim()
    ? encryptSecret(input.webhookSecret.trim())
    : row?.webhook_secret_encrypted ?? null;
  if (input.enabled && (!secretEncrypted || !webhookEncrypted || !input.transferAccountGuid)) {
    throw new Error('Secret key, webhook signing secret, and deposit account are required before enabling payments');
  }
  const saved = await query(
    `INSERT INTO gnucash_web_payment_connections
      (book_guid, provider, secret_key_encrypted, webhook_secret_encrypted,
       transfer_account_guid, fee_account_guid, enabled, updated_by)
     VALUES ($1,'stripe',$2,$3,$4,$5,$6,$7)
     ON CONFLICT (book_guid) DO UPDATE SET
       secret_key_encrypted = EXCLUDED.secret_key_encrypted,
       webhook_secret_encrypted = EXCLUDED.webhook_secret_encrypted,
       transfer_account_guid = EXCLUDED.transfer_account_guid,
       fee_account_guid = EXCLUDED.fee_account_guid,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [
      input.bookGuid,
      secretEncrypted,
      webhookEncrypted,
      input.transferAccountGuid || null,
      input.feeAccountGuid || null,
      input.enabled,
      input.userId,
    ],
  );
  const savedView = view(saved.rows[0] as ConnectionRow);
  await logAudit(
    row ? 'UPDATE' : 'CREATE',
    'PAYMENT_CONNECTION',
    input.bookGuid,
    row ? view(row) : null,
    savedView,
    { bookGuid: input.bookGuid, userId: input.userId },
  );
  return savedView;
}

function internal(row: ConnectionRow): StripeConnection | null {
  const secretKey = decryptSecret(row.secret_key_encrypted);
  const webhookSecret = decryptSecret(row.webhook_secret_encrypted);
  if (!row.enabled || !secretKey || !webhookSecret || !row.transfer_account_guid) return null;
  return {
    bookGuid: row.book_guid,
    secretKey,
    webhookSecret,
    transferAccountGuid: row.transfer_account_guid,
    feeAccountGuid: row.fee_account_guid,
  };
}

export async function getStripeConnection(bookGuid: string): Promise<StripeConnection | null> {
  const result = await query(
    'SELECT * FROM gnucash_web_payment_connections WHERE book_guid = $1 AND enabled = TRUE',
    [bookGuid],
  );
  return result.rows[0] ? internal(result.rows[0] as ConnectionRow) : null;
}

export async function listStripeConnections(): Promise<StripeConnection[]> {
  const result = await query(
    'SELECT * FROM gnucash_web_payment_connections WHERE enabled = TRUE AND provider = $1',
    ['stripe'],
  );
  return (result.rows as ConnectionRow[]).map(internal).filter((item): item is StripeConnection => Boolean(item));
}
