import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageBackend } from './storage-backend';

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
