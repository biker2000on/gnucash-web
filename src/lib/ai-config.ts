// src/lib/ai-config.ts

import crypto from 'crypto';
import { query } from './db';
import type { AiConfig } from './receipt-extraction';

const ALGORITHM = 'aes-256-cbc';

function getEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET || '';
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string | null {
  try {
    const [ivHex, encHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null; // Key changed or corrupted — user needs to re-enter
  }
}

/** Get AI config for a user. Checks DB first, falls back to env vars. */
export async function getAiConfig(userId: number): Promise<AiConfig | null> {
  // Check DB config first
  const result = await query(
    'SELECT * FROM gnucash_web_ai_config WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length > 0 && result.rows[0].enabled) {
    const row = result.rows[0];
    const apiKey = row.api_key_encrypted ? decrypt(row.api_key_encrypted) : null;
    return {
      provider: row.provider,
      base_url: row.base_url,
      api_key: apiKey,
      model: row.model,
      enabled: row.enabled,
    };
  }

  // Fall back to env vars
  const envKey = process.env.AI_API_KEY;
  const envBaseUrl = process.env.AI_BASE_URL;
  const envModel = process.env.AI_MODEL;

  if (envBaseUrl && envModel) {
    return {
      provider: 'custom',
      base_url: envBaseUrl,
      api_key: envKey || null,
      model: envModel,
      enabled: true,
    };
  }

  return null;
}

/** Save AI config for a user. */
export async function saveAiConfig(
  userId: number,
  config: { provider: string; base_url: string | null; api_key: string | null; model: string | null; enabled: boolean }
): Promise<void> {
  const encryptedKey = config.api_key ? encrypt(config.api_key) : null;

  await query(
    `INSERT INTO gnucash_web_ai_config (user_id, provider, base_url, api_key_encrypted, model, enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       base_url = EXCLUDED.base_url,
       api_key_encrypted = EXCLUDED.api_key_encrypted,
       model = EXCLUDED.model,
       enabled = EXCLUDED.enabled,
       updated_at = NOW()`,
    [userId, config.provider, config.base_url, encryptedKey, config.model, config.enabled]
  );
}

/** Get AI config for display (redacts API key). */
export async function getAiConfigForDisplay(userId: number): Promise<{
  provider: string;
  base_url: string | null;
  has_api_key: boolean;
  api_key_valid: boolean;
  model: string | null;
  enabled: boolean;
} | null> {
  const result = await query(
    'SELECT * FROM gnucash_web_ai_config WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const hasKey = !!row.api_key_encrypted;
  const keyValid = hasKey ? decrypt(row.api_key_encrypted) !== null : true;

  return {
    provider: row.provider,
    base_url: row.base_url,
    has_api_key: hasKey,
    api_key_valid: keyValid,
    model: row.model,
    enabled: row.enabled,
  };
}
