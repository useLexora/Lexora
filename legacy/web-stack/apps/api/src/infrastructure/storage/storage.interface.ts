import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'

/**
 * 存储对象内容展示策略。
 */
export interface StorageContentDisposition {
  type: 'inline' | 'attachment'
  fileName?: string
  fallbackFileName?: string
}

/**
 * 存储写入参数。
 */
export interface StoragePutObjectInput {
  bucket: string
  key: string
  body: Buffer | Readable
  contentType: string
  contentLength?: number
  contentDisposition?: StorageContentDisposition
  cacheControl?: string
}

/**
 * 存储读取参数。
 */
export interface StorageObjectLocator {
  bucket: string
  key: string
}

/**
 * 存储对象读取结果。
 */
export interface StorageObject {
  body: Readable
  contentType: string
  contentLength: number | null
  etag: string | null
}
