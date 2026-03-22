export interface StorageBackend {
  put(key: string, buffer: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  getUrl(key: string): Promise<string>;
}

let _backend: StorageBackend | null = null;
let _initPromise: Promise<StorageBackend> | null = null;

/** Get or initialize the storage backend singleton (serialized to prevent double-init). */
export async function getStorageBackend(): Promise<StorageBackend> {
  if (_backend) return _backend;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const type = process.env.RECEIPT_STORAGE || 'filesystem';
    if (type === 's3') {
      const { S3Storage } = await import('./s3-storage');
      _backend = new S3Storage();
    } else {
      const { FilesystemStorage } = await import('./filesystem-storage');
      _backend = new FilesystemStorage();
    }
    _initPromise = null;
    return _backend!;
  })();

  return _initPromise;
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
