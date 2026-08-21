import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageBackend } from './storage-backend';

/**
 * Time to establish a TCP/TLS connection to the object store. MinIO is on the
 * LAN; anything slower than this is a dead host, not a slow one.
 */
export const S3_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Time a single request may spend without socket activity. Without it the SDK
 * waits forever: a stalled MinIO read (ZFS IO storm) never rejects, the route
 * awaiting it never returns, and the browser request hangs until the user
 * gives up. Applies uniformly to get/put/delete because it is set on the
 * client's request handler.
 */
export const S3_REQUEST_TIMEOUT_MS = 30_000;

export class S3Storage implements StorageBackend {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.bucket = process.env.RECEIPT_S3_BUCKET || 'gnucash-receipts';
    this.client = new S3Client({
      endpoint: process.env.RECEIPT_S3_ENDPOINT,
      region: process.env.RECEIPT_S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.RECEIPT_S3_ACCESS_KEY || '',
        secretAccessKey: process.env.RECEIPT_S3_SECRET_KEY || '',
      },
      forcePathStyle: true,
      // Object form: the SDK builds its default NodeHttpHandler with these
      // options, so no direct dependency on @smithy/node-http-handler.
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
      },
    });
  }

  async put(key: string, buffer: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: buffer, ContentType: contentType,
    }));
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = response.Body;
    if (!stream) throw new Error(`Empty response for key: ${key}`);
    return Buffer.from(await stream.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async getUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }
}
