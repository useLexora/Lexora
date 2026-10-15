import type { SyncConnection } from '../../../shared/sync/syncApi'
import type { SyncTransport } from '../SyncAdapter'
import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { S3Adapter } from '../S3Adapter'

const connection: Extract<SyncConnection, { adapter: 's3' }> = { id: randomUUID(), name: 'Fixture', adapter: 's3', endpoint: 'https://storage.example.invalid/api/', bucket: 'lexora-backups', region: 'us-east-1', prefix: '备份 空格/%2F/+literal', accessKeyId: 'fixture-key', pathStyle: true }
const signal = new AbortController().signal
const key = `objects/${'a'.repeat(64)}`

it.each([true, false])('signs the exact object address and body with pathStyle=%s', async (pathStyle) => {
  const bytes = new TextEncoder().encode('backup contents')
  const requests: Parameters<SyncTransport>[] = []
  const adapter = new S3Adapter({ ...connection, pathStyle }, 'fixture-secret', async (...request) => {
    requests.push(request)
    return new Response(null, { status: 200 })
  })
  await adapter.write(key, bytes, signal)
  expect(requests).toHaveLength(1)
  const [url, init] = requests[0]!
  const parsed = new URL(url)
  expect(parsed.hostname).toBe(pathStyle ? 'storage.example.invalid' : 'lexora-backups.storage.example.invalid')
  expect(decodeURIComponent(parsed.pathname)).toBe(`/api${pathStyle ? '/lexora-backups' : ''}/${connection.prefix}/lexora-backups-v1/${key}`)
  expect(init.method).toBe('PUT')
  expect(init.body).toEqual(bytes)
  expect(init.headers['x-amz-content-sha256']).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(init.headers.authorization).toMatch(/AWS4-HMAC-SHA256 Credential=fixture-key\/\d{8}\/us-east-1\/s3\/aws4_request/)
  expect(init.headers['if-none-match']).toBe('*')
  expect(init.headers).not.toHaveProperty('host')
  expect(init.headers).not.toHaveProperty('content-length')
  expect(JSON.stringify(init.headers)).not.toContain('fixture-secret')
})

it('lists raw and URL-encoded Unicode keys across pages without double-decoding or including unrelated objects', async () => {
  const ids = [randomUUID(), randomUUID()]
  const prefix = `${connection.prefix}/lexora-backups-v1/snapshots/`
  const adapter = new S3Adapter(connection, 'fixture-secret', async (url) => {
    const query = new URL(url).searchParams
    expect(query.get('prefix')).toBe(prefix)
    expect(query.get('list-type')).toBe('2')
    const second = query.has('continuation-token')
    if (second)
      expect(query.get('continuation-token')).toBe('next/+==')
    const key = `${prefix}${ids[second ? 1 : 0]}.json`
    return new Response(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${second ? '<EncodingType>url</EncodingType>' : ''}<IsTruncated>${!second}</IsTruncated><Contents><Key>${second ? encodeURIComponent(key) : key}</Key></Contents><Contents><Key>elsewhere/${ids[0]}.json</Key></Contents>${second ? '' : '<NextContinuationToken>next/+==</NextContinuationToken>'}</ListBucketResult>`)
  })
  expect(await adapter.list(signal)).toEqual(ids.sort())
})

it('rejects cyclic pagination instead of hanging on a broken remote', async () => {
  const adapter = new S3Adapter(connection, 'fixture-secret', async () => new Response('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken></ListBucketResult>'))
  await expect(adapter.list(signal)).rejects.toThrow('SYNC_INVALID_RESPONSE')
})

it('accepts an existing identical object but reports conflicting bytes', async () => {
  const bytes = new TextEncoder().encode('original')
  for (const existing of ['original', 'modified']) {
    const adapter = new S3Adapter(connection, 'fixture-secret', async (_url, init) => init.method === 'PUT' ? new Response(null, { status: 412 }) : new Response(existing))
    if (existing === 'original')
      await expect(adapter.write(key, bytes, signal)).resolves.toBeUndefined()
    else
      await expect(adapter.write(key, bytes, signal)).rejects.toThrow('SYNC_REMOTE_CONFLICT')
  }
})

it.each([[401, 'SYNC_AUTHENTICATION_FAILED'], [403, 'SYNC_PERMISSION_DENIED'], [404, 'SYNC_BUCKET_MISSING'], [301, 'SYNC_REDIRECT_REFUSED']] as const)('reports an actionable error for status %s', async (status, error) => {
  const adapter = new S3Adapter(connection, 'fixture-secret', async () => new Response(null, { status }))
  await expect(adapter.test(signal)).rejects.toThrow(error)
})

it('reads bounded object streams and closes an oversized response', async () => {
  let closed = false
  const adapter = new S3Adapter(connection, 'fixture-secret', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(16))
    },
    cancel() {
      closed = true
    },
  })))
  await expect(adapter.read(key, 8, signal)).rejects.toThrow('SYNC_RESPONSE_TOO_LARGE')
  expect(closed).toBe(true)
})

it('bounds XML responses before the SDK parses them', async () => {
  const adapter = new S3Adapter(connection, 'fixture-secret', async () => new Response(' '.repeat(4 * 1024 * 1024 + 1)))
  await expect(adapter.list(signal)).rejects.toThrow('SYNC_RESPONSE_TOO_LARGE')
})

it('distinguishes missing objects from missing buckets and authentication failures', async () => {
  const missing = new S3Adapter(connection, 'fixture-secret', async () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }))
  expect(await missing.read(key, 8, signal)).toBeNull()
  await expect(missing.remove(key, signal)).resolves.toBeUndefined()
  const bucket = new S3Adapter(connection, 'fixture-secret', async () => new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 }))
  await expect(bucket.read(key, 8, signal)).rejects.toThrow('SYNC_BUCKET_MISSING')
  const denied = new S3Adapter(connection, 'fixture-secret', async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }))
  await expect(denied.write(key, new Uint8Array(1), signal)).rejects.toThrow('SYNC_PERMISSION_DENIED')
})

it('retries a transient server error with the same object bytes and conditional write', async () => {
  const bytes = new TextEncoder().encode('retry contents')
  const attempts: { url: string, body?: Uint8Array, condition?: string }[] = []
  const adapter = new S3Adapter(connection, 'fixture-secret', async (url, init) => {
    attempts.push({ url, body: init.body, condition: init.headers['if-none-match'] })
    return attempts.length === 1 ? new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }) : new Response(null, { status: 200 })
  })
  await adapter.write(key, bytes, signal)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
  expect(attempts[0]).toMatchObject({ body: bytes, condition: '*' })
})

it('propagates cancellation through the configured transport without retrying', async () => {
  const controller = new AbortController()
  let requests = 0
  const adapter = new S3Adapter(connection, 'fixture-secret', async (_url, input) => {
    requests++
    const response = new Promise<Response>((_resolve, reject) => {
      input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
    })
    controller.abort(new Error('fixture cancellation'))
    return response
  })
  await expect(adapter.read(key, 8, controller.signal)).rejects.toThrow('fixture cancellation')
  expect(requests).toBe(1)
})

it('rejects an unexpected listing instead of presenting it as an empty backup list', async () => {
  const adapter = new S3Adapter(connection, 'fixture-secret', async () => new Response('<html>Wrong endpoint</html>'))
  await expect(adapter.list(signal)).rejects.toThrow('SYNC_INVALID_RESPONSE')
})

it.each(['InvalidAccessKeyId', 'SignatureDoesNotMatch'])('identifies invalid credentials from S3 error %s even with HTTP 403', async (code) => {
  const adapter = new S3Adapter(connection, 'fixture-secret', async () => new Response(`<Error><Code>${code}</Code></Error>`, { status: 403 }))
  await expect(adapter.write(key, new Uint8Array(1), signal)).rejects.toThrow('SYNC_AUTHENTICATION_FAILED')
})
