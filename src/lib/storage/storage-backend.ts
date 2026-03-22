export interface StorageBackend {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getUrl(key: string): Promise<string>;
}

let _backend: StorageBackend | null = null;

export async function getStorageBackend(): Promise<StorageBackend> {
  if (_backend) return _backend;
  const type = process.env.RECEIPT_STORAGE || 'filesystem';
  if (type === 's3') {
    const { S3Storage } = await import('./s3-storage');
    _backend = new S3Storage();
  } else {
    const { FilesystemStorage } = await import('./filesystem-storage');
    _backend = new FilesystemStorage();
  }
  return _backend!;
}

export function generateStorageKey(originalFilename: string): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const uuid = crypto.randomUUID();
  const ext = originalFilename.split('.').pop()?.toLowerCase() || 'bin';
  return `${yyyy}/${mm}/${uuid}.${ext}`;
}

export function thumbnailKeyFrom(storageKey: string): string {
  const dotIdx = storageKey.lastIndexOf('.');
  if (dotIdx === -1) return `${storageKey}_thumb.jpg`;
  return `${storageKey.substring(0, dotIdx)}_thumb.jpg`;
}
