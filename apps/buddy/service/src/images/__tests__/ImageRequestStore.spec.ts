import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { ImageRequestStore } from '../ImageRequestStore'

const roots: string[] = []
const identity = { fingerprint: 'a'.repeat(64), destination: 'b'.repeat(64) }
const references = [
  { referenceId: 'character', mimeType: 'image/png', sha256: 'c'.repeat(64) },
  { referenceId: 'pose', mimeType: 'image/png', sha256: 'd'.repeat(64) },
]
const result = { artifactIds: ['output'], outputs: [{ artifactId: 'output', path: '/workspace/output.png', mimeType: 'image/png' }], responseId: 'response' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'image-request-'))
  roots.push(root)
  const paths = new BuddyDataPaths(root)
  const store = new ImageRequestStore(paths)
  const conversationId = randomUUID()
  const runId = randomUUID()
  const begun = await store.begin(conversationId, runId, 'call', identity, references)
  if (begun.kind !== 'started')
    throw new Error('Expected new request')
  const path = join(paths.conversationDirectory(conversationId), 'image-requests', runId, `${begun.receipt.request.requestId}.json`)
  return { store, paths, conversationId, runId, receipt: begun.receipt, path }
}

describe('image request reference evidence', () => {
  it('persists ordered input identities before submission and preserves completed replay', async () => {
    const f = await fixture()
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'preparing', identity, references })
    await f.receipt.submitting()
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'unknown', references })
    await f.receipt.complete(result)
    expect(await new ImageRequestStore(f.paths).completed(f.conversationId, f.runId, 'call')).toEqual({ result, request: f.receipt.request })
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'completed', references })
  })

  it('reads completed legacy receipts without reference evidence and does not rewrite them', async () => {
    const f = await fixture()
    await f.receipt.complete(result)
    const previous = JSON.parse(await readFile(f.path, 'utf8'))
    delete previous.references
    delete previous.identity
    delete previous.version
    const bytes = JSON.stringify(previous)
    await writeFile(f.path, bytes)
    const restored = new ImageRequestStore(f.paths)
    expect(await restored.completed(f.conversationId, f.runId, 'call')).toEqual({ result, request: f.receipt.request })
    expect(await readFile(f.path, 'utf8')).toBe(bytes)
  })

  it.each(['unknown', 'partial'] as const)('does not let new reference metadata bypass an unresolved %s request', async (state) => {
    const f = await fixture()
    await f.receipt.submitting()
    if (state === 'partial')
      await f.receipt.fail({ code: 'IMAGE_GENERATION_FAILED', outcome: 'partial', diagnostic: null }, ['output'])
    const restored = new ImageRequestStore(f.paths)
    await expect(restored.begin(f.conversationId, f.runId, 'another-call', identity, [...references].reverse())).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BLOCKED', outcome: state, request: f.receipt.request })
    expect(JSON.parse(await readFile(f.path, 'utf8')).references).toEqual(references)
  })

  it('persists retained outputs before publication and blocks replay after restart without rewriting the receipt', async () => {
    const f = await fixture()
    const retainedOutputs = [{ path: '/authorized/scratch/original.png', mimeType: 'image/png' as const, sizeBytes: 73, sha256: 'e'.repeat(64) }]
    await f.receipt.submitting()
    await f.receipt.retain(retainedOutputs)
    const bytes = await readFile(f.path, 'utf8')
    expect(JSON.parse(bytes)).toMatchObject({ state: 'partial', retainedOutputs })
    const restored = new ImageRequestStore(f.paths)
    for (const toolCallId of ['call', 'another-call']) {
      await expect(restored.begin(f.conversationId, f.runId, toolCallId, identity)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_BLOCKED', outcome: 'partial', request: f.receipt.request, retainedOutputs })
    }
    expect(await readFile(f.path, 'utf8')).toBe(bytes)
    expect(await restored.begin(randomUUID(), f.runId, 'call', identity)).toMatchObject({ kind: 'started' })
    await f.receipt.complete(result)
    expect(await restored.begin(f.conversationId, f.runId, 'call', identity)).toEqual({ kind: 'completed', request: f.receipt.request, result })
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'completed', retainedOutputs })
  })

  it('records the actual selected identities when resuming an unsubmitted preparation', async () => {
    const f = await fixture()
    const selected = references.map(reference => ({ ...reference, referenceId: `${reference.referenceId}-copy` }))
    const restored = new ImageRequestStore(f.paths)
    expect(await restored.begin(f.conversationId, f.runId, 'call', identity, selected)).toMatchObject({ kind: 'started', receipt: { request: f.receipt.request } })
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'preparing', identity, references: selected })
  })
})
