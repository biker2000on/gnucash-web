import crypto from 'crypto';

const VERSION = 'v1';

function key(): Buffer {
  const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('SESSION_SECRET or NEXTAUTH_SECRET is required to encrypt credentials');
  return crypto.createHash('sha256').update(secret).digest();
}

/** AES-256-GCM envelope for durable connector credentials. */
export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptSecret(value: string | null): string | null {
  if (!value) return null;
  try {
    const [version, ivHex, tagHex, encryptedHex] = value.split(':');
    if (version !== VERSION) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
