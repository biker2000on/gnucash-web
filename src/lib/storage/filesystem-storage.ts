import fs from 'fs/promises';
import path from 'path';
import { StorageBackend } from './storage-backend';

const RECEIPTS_DIR = process.env.RECEIPTS_DIR || path.join(process.cwd(), 'data', 'receipts');

export class FilesystemStorage implements StorageBackend {
  async put(key: string, buffer: Buffer, _contentType: string): Promise<void> {
    const filePath = path.join(RECEIPTS_DIR, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
  }

  async get(key: string): Promise<Buffer> {
    const filePath = path.join(RECEIPTS_DIR, key);
    return fs.readFile(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = path.join(RECEIPTS_DIR, key);
    try {
      await fs.unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async getUrl(key: string): Promise<string> {
    return `/api/receipts/file/${encodeURIComponent(key)}`;
  }
}
