import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
interface S3ClientConfigLike {
  requestHandler?: { connectionTimeout?: number; requestTimeout?: number };
}

const S3ClientMock = vi.fn(function S3Client(
  this: unknown,
  _config: S3ClientConfigLike,
) {
  void _config;
  Object.assign(this as object, { send });
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: S3ClientMock,
  PutObjectCommand: vi.fn(function PutObjectCommand(this: unknown, input: unknown) {
    Object.assign(this as object, { input, name: 'PutObjectCommand' });
  }),
  GetObjectCommand: vi.fn(function GetObjectCommand(this: unknown, input: unknown) {
    Object.assign(this as object, { input, name: 'GetObjectCommand' });
  }),
  DeleteObjectCommand: vi.fn(function DeleteObjectCommand(this: unknown, input: unknown) {
    Object.assign(this as object, { input, name: 'DeleteObjectCommand' });
  }),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/object'),
}));

const {
  S3Storage,
  S3_CONNECTION_TIMEOUT_MS,
  S3_REQUEST_TIMEOUT_MS,
} = await import('@/lib/storage/s3-storage');

function clientConfig(): S3ClientConfigLike {
  const config = S3ClientMock.mock.calls.at(-1)?.[0];
  if (!config) throw new Error('S3Client was never constructed');
  return config;
}

describe('S3Storage client configuration', () => {
  beforeEach(() => {
    S3ClientMock.mockClear();
    send.mockReset();
    send.mockResolvedValue({});
  });

  it('constructs the client with explicit connection and request timeouts', () => {
    new S3Storage();

    expect(S3ClientMock).toHaveBeenCalledTimes(1);
    expect(clientConfig().requestHandler).toEqual({
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
    });
  });

  it('uses finite timeouts (a stalled read must reject, not hang the route)', () => {
    expect(S3_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(S3_CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(S3_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(S3_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('applies the same timed-out client to the get, put and delete paths', async () => {
    const storage = new S3Storage();
    const handler = clientConfig().requestHandler;

    send.mockResolvedValueOnce({});
    await storage.put('receipts/a.pdf', Buffer.from('pdf'), 'application/pdf');

    send.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
    expect(await storage.get('receipts/a.pdf')).toEqual(Buffer.from([1, 2, 3]));

    send.mockResolvedValueOnce({});
    await storage.delete('receipts/a.pdf');

    // One client, three sends — the timeouts cannot be bypassed per call.
    expect(S3ClientMock).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(handler).toEqual({
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
    });
  });

  it('surfaces a timed-out read as a rejection instead of hanging', async () => {
    const storage = new S3Storage();
    send.mockRejectedValueOnce(
      Object.assign(new Error('Connection timed out after 30000 ms'), {
        name: 'TimeoutError',
      }),
    );

    await expect(storage.get('receipts/stalled.pdf')).rejects.toThrow(/timed out/i);
  });
});
