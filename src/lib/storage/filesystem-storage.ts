import fs from 'fs/promises';
import path from 'path';
import { StorageBackend } from './storage-backend';

const RECEIPTS_DIR = process.env.RECEIPTS_DIR || path.join(process.cwd(), 'data', 'receipts');

/** Resolve key to a safe path within RECEIPTS_DIR, rejecting path traversal attempts. */
function safePath(key: string): string {
  const resolved = path.resolve(RECEIPTS_DIR, key);
  const base = path.resolve(RECEIPTS_DIR) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(RECEIPTS_DIR)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

export class FilesystemStorage implements StorageBackend {
  async put(key: string, buffer: Buffer, _contentType: string): Promise<void> {
    const filePath = safePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(safePath(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(safePath(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async getUrl(key: string): Promise<string> {
    return `/api/receipts/file/${encodeURIComponent(key)}`;
  }
}
