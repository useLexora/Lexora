import type { Readable } from 'node:stream'
import type { StorageConfig } from '../../config/storage.config'
import type {
  StorageObject,
  StorageObjectLocator,
  StoragePutObjectInput,
} from './storage.interface'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Injectable, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { buildStorageContentDisposition } from './storage.utils'

@Injectable()
export class StorageService {
  private readonly config: StorageConfig
  private readonly client: S3Client
  private readonly ensuredBuckets = new Map<string, Promise<void>>()

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<StorageConfig>('storage')
    this.client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
    })
  }

  async putObject(input: StoragePutObjectInput): Promise<void> {
    await this.ensureBucket(input.bucket)

    await this.client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
      ContentDisposition: input.contentDisposition ? buildStorageContentDisposition(input.contentDisposition) : undefined,
      CacheControl: input.cacheControl,
    }))
  }

  async getObject(input: StorageObjectLocator): Promise<StorageObject> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }))

      if (!result.Body) {
        throw new NotFoundException('存储对象不存在')
      }

      return {
        body: result.Body as Readable,
        contentType: result.ContentType ?? 'application/octet-stream',
        contentLength: typeof result.ContentLength === 'number' ? result.ContentLength : null,
        etag: typeof result.ETag === 'string' ? result.ETag : null,
      }
    }
    catch (error) {
      if (error instanceof NoSuchKey) {
        throw new NotFoundException('存储对象不存在')
      }

      throw error
    }
  }

  async deleteObject(input: StorageObjectLocator): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
    })).catch(() => {})
  }

  async ensureBucket(bucket: string): Promise<void> {
    this.ensuredBuckets.set(bucket, this.ensuredBuckets.get(bucket) ?? this.createBucketIfNeeded(bucket))
    return this.ensuredBuckets.get(bucket)!
  }

  private async createBucketIfNeeded(bucket: string): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }))
    }
    catch {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }))
    }
  }
}
