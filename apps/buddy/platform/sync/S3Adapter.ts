import type { HttpHandlerOptions, HttpRequest } from '@smithy/types'
import type { SyncConnection } from '../../shared/sync/syncApi'
import type { SyncAdapter, SyncTransport } from './SyncAdapter'
import { Buffer } from 'node:buffer'
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, paginateListObjectsV2, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3'
import { formatUrl } from '@aws-sdk/util-format-url'
import { readLimitedResponse } from './SyncAdapter'

type S3Connection = Extract<SyncConnection, { adapter: 's3' }>
export class S3Adapter implements SyncAdapter {
  readonly #connection: S3Connection
  readonly #client: S3Client
  constructor(connection: S3Connection, secret: string, request: SyncTransport) {
    this.#connection = connection
    this.#client = new S3Client({
      endpoint: connection.endpoint.replace(/\/+$/, ''),
      region: connection.region,
      forcePathStyle: connection.pathStyle,
      credentials: { accessKeyId: connection.accessKeyId, secretAccessKey: secret },
      maxAttempts: 3,
      retryMode: 'standard',
      followRegionRedirects: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      streamCollector: stream => readLimitedResponse(new Response(stream), 4 * 1024 * 1024),
      requestHandler: {
        handle: async (input: HttpRequest, options?: HttpHandlerOptions) => {
          const signal = options?.abortSignal as AbortSignal
          signal.throwIfAborted()
          const body = typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body as Uint8Array | undefined
          const headers = Object.fromEntries(Object.entries(input.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())))
          const response = await request(formatUrl(input), { method: input.method, headers, body, signal })
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel()
            throw new Error('SYNC_REDIRECT_REFUSED')
          }
          if (input.method === 'HEAD')
            await response.body?.cancel()
          return { response: { statusCode: response.status, headers: Object.fromEntries(response.headers), body: input.method === 'HEAD' ? undefined : response.body ?? undefined } }
        },
      },
    })
  }

  #objectKey(key: string): string {
    if (!/^(?:objects\/(?:[a-f0-9-]{36}-)?[a-f0-9]{64}|snapshots\/[a-f0-9-]{36}\.json)$/.test(key))
      throw new Error('SYNC_INVALID_KEY')
    return `${this.#prefix()}${key}`
  }

  #prefix(): string {
    return `${this.#connection.prefix ? `${this.#connection.prefix}/` : ''}lexora-backups-v1/`
  }

  async #run<T>(signal: AbortSignal, fallback: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abortSignal = AbortSignal.any([signal, AbortSignal.timeout(120000)])
    abortSignal.throwIfAborted()
    try {
      return await action(abortSignal)
    }
    catch (error) {
      abortSignal.throwIfAborted()
      if (error instanceof Error && error.message.startsWith('SYNC_'))
        throw error
      if (error instanceof S3ServiceException) {
        if (error.$metadata.httpStatusCode === 401 || ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken'].includes(error.name))
          throw new Error('SYNC_AUTHENTICATION_FAILED')
        if (error.$metadata.httpStatusCode === 403)
          throw new Error('SYNC_PERMISSION_DENIED')
        if (error.name === 'NoSuchBucket')
          throw new Error('SYNC_BUCKET_MISSING')
      }
      throw new Error(fallback)
    }
  }

  async test(signal: AbortSignal): Promise<void> {
    await this.#run(signal, 'SYNC_S3_UNAVAILABLE', async (abortSignal) => {
      try {
        await this.#client.send(new HeadBucketCommand({ Bucket: this.#connection.bucket }), { abortSignal })
      }
      catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
          throw new Error('SYNC_BUCKET_MISSING')
        throw error
      }
    })
  }

  async prepare(signal: AbortSignal): Promise<void> {
    await this.test(signal)
  }

  async list(signal: AbortSignal): Promise<string[]> {
    return this.#run(signal, 'SYNC_REMOTE_READ_FAILED', async (abortSignal) => {
      const prefix = `${this.#prefix()}snapshots/`
      const ids = new Set<string>()
      const visited = new Set<string>()
      for await (const page of paginateListObjectsV2({ client: this.#client }, { Bucket: this.#connection.bucket, Prefix: prefix }, { abortSignal })) {
        if (typeof page.IsTruncated !== 'boolean')
          throw new Error('SYNC_INVALID_RESPONSE')
        for (const item of page.Contents ?? []) {
          const key = page.EncodingType === 'url' ? decodeURIComponent(item.Key ?? '') : item.Key ?? ''
          if (!key.startsWith(prefix))
            continue
          const name = key.slice(prefix.length)
          if (/^[a-f0-9-]{36}\.json$/.test(name))
            ids.add(name.slice(0, -5))
        }
        if (page.IsTruncated) {
          const token = page.NextContinuationToken
          if (!token || visited.has(token))
            throw new Error('SYNC_INVALID_RESPONSE')
          visited.add(token)
        }
      }
      return [...ids].sort()
    })
  }

  async read(key: string, limit: number, signal: AbortSignal): Promise<Uint8Array | null> {
    const Key = this.#objectKey(key)
    return this.#run(signal, 'SYNC_REMOTE_READ_FAILED', async (abortSignal) => {
      try {
        const result = await this.#client.send(new GetObjectCommand({ Bucket: this.#connection.bucket, Key }), { abortSignal })
        return readLimitedResponse(new Response(result.Body?.transformToWebStream()), limit)
      }
      catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404 && error.name !== 'NoSuchBucket')
          return null
        throw error
      }
    })
  }

  async remove(key: string, signal: AbortSignal): Promise<void> {
    const Key = this.#objectKey(key)
    await this.#run(signal, 'SYNC_REMOTE_DELETE_FAILED', async (abortSignal) => {
      try {
        await this.#client.send(new DeleteObjectCommand({ Bucket: this.#connection.bucket, Key }), { abortSignal })
      }
      catch (error) {
        if (!(error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404 && error.name !== 'NoSuchBucket'))
          throw error
      }
    })
  }

  async write(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const Key = this.#objectKey(key)
    await this.#run(signal, 'SYNC_REMOTE_WRITE_FAILED', async (abortSignal) => {
      try {
        await this.#client.send(new PutObjectCommand({ Bucket: this.#connection.bucket, Key, Body: bytes, ContentType: 'application/octet-stream', IfNoneMatch: '*' }), { abortSignal })
      }
      catch (error) {
        if (!(error instanceof S3ServiceException && [409, 412].includes(error.$metadata.httpStatusCode ?? 0)))
          throw error
        const existing = await this.read(key, bytes.length, abortSignal)
        if (!existing || !Buffer.from(existing).equals(bytes))
          throw new Error('SYNC_REMOTE_CONFLICT')
      }
    })
  }
}
