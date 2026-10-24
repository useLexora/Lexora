import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { AttachmentService } from '../../attachments/AttachmentService'
import { AttachmentToolWorkspace } from '../../attachments/AttachmentToolWorkspace'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createConversationHistoryStore } from '../../storage/conversationHistoryRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionReferenceRepository } from '../../storage/extensionReferenceRepository'
import { createRunRepository } from '../../storage/runRepository'
import { ReferenceSnapshotAccess } from '../ReferenceSnapshotAccess'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'saved-text-attachments-'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const conversations = createConversationRepository(database)
  const repository = createAttachmentRepository(database)
  const attachments = new AttachmentService({ paths: new BuddyDataPaths(root), repository })
  const references = createExtensionReferenceRepository(database, createConversationHistoryStore(database).lineage)
  const controller = new AbortController()
  let currentRunId: string | undefined
  let sequence = 0
  cleanups.push(async () => {
    await attachments.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const id of ['task', 'other'])
    conversations.create({ id, branchId: `${id}-branch`, title: id, spaceId: null, approvalPolicy: 'policy', executionProfile: 'read_only', createdAt: '2026-10-24T00:00:00.000Z' })
  async function input(text: string, options: { conversationId?: string, branchId?: string, mimeType?: string, name?: string, resourceId?: string } = {}) {
    const conversationId = options.conversationId ?? 'task'
    const branchId = options.branchId ?? `${conversationId}-branch`
    const id = `message-${++sequence}`
    const resourceId = options.resourceId ?? `resource-${sequence}`
    const draftId = `draft-${sequence}`
    const createdAt = new Date(Date.UTC(2026, 9, 24, 0, 0, sequence)).toISOString()
    const [upload] = await attachments.registerUploads(draftId, [{ name: options.name ?? 'input.txt', mimeType: options.mimeType ?? 'text/plain', bytes: Buffer.from(text) }])
    const prepared = await attachments.prepareMessageAttachments({ attachmentIds: [upload!.id], conversationId, draftId, messageId: id })
    const binding = prepared.bindings[0]!
    const message = conversations.createMessage({ id, conversationId, branchId, runId: null, role: 'user', createdAt, content: { userContent: { ...createBuddyUserContent('Read this attachment'), panelResourceIds: [resourceId] }, resourceSnapshots: [{ resourceId, attachmentId: binding.id }] } })
    database.prepare('UPDATE attachments SET draft_id = NULL, message_id = ?, stored_path = ? WHERE id = ?').run(id, binding.storedPath, binding.id)
    await prepared.commit()
    return { message, resourceId, record: repository.findById(binding.id)! }
  }
  function run(input: { message: { id: string, conversationId: string, branchId: string, createdAt: string } }, activate = true) {
    const id = `run-${++sequence}`
    createRunRepository(database).create({ id, conversationId: input.message.conversationId, branchId: input.message.branchId, triggeringMessageId: input.message.id, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'read_only', startedAt: input.message.createdAt })
    if (activate)
      currentRunId = id
    return id
  }
  function access(service: Pick<AttachmentService, 'getInputMetadata' | 'readText'> = attachments) {
    return new ReferenceSnapshotAccess({ conversationId: 'task', getRunId: () => currentRunId, references, attachments: service, signal: controller.signal })
  }
  return { root, database, conversations, attachments, references, controller, input, run, access }
}

function identity(input: { message: { id: string }, resourceId: string }) {
  return { sourceMessageId: input.message.id, referenceId: input.resourceId, kind: 'attachment' as const }
}

describe('saved attachment reference snapshots', () => {
  it('reads saved bytes by resource identity after the workspace copy changes without exposing host storage paths', async () => {
    const f = await fixture()
    const text = 'Original😀字\u0001'.repeat(5000)
    const input = await f.input(text)
    f.run(input)
    const access = f.access()
    const listing = access.list({})
    expect(listing).toMatchObject({ total: 1, nextOffset: null, items: [{ ...identity(input), title: 'input.txt' }] })
    const workspace = new AttachmentToolWorkspace(f.root)
    const workingPath = await workspace.materialize(input.record, Buffer.from(text))
    await writeFile(workingPath, 'Changed working copy')
    let offset: number | null = 0
    let restored = ''
    while (offset !== null) {
      const page = await access.readMaterial({ ...identity(input), offset })
      expect(page).toMatchObject({ state: 'snapshot', totalLength: text.length, offset })
      expect(new TextEncoder().encode(JSON.stringify(page.text)).byteLength).toBeLessThanOrEqual(32 * 1024)
      expect(JSON.stringify(page)).not.toContain(input.record.storedPath)
      restored += page.text
      offset = page.nextOffset
    }
    expect(restored).toBe(text)
    expect(await readFile(workingPath, 'utf8')).toBe('Changed working copy')
    expect(await readFile(input.record.storedPath, 'utf8')).toBe(text)
    expect(JSON.stringify(listing)).not.toContain(input.record.storedPath)
    expect(JSON.stringify(listing)).not.toContain(input.record.id)
    await expect(access.readMaterial({ ...identity(input), referenceId: input.record.id })).rejects.toThrow('REFERENCE_NOT_AUTHORIZED')
  })

  it('filters accepted branch history before counting and paging text attachments including SVG', async () => {
    const f = await fixture()
    const ancestor = await f.input('ancestor')
    f.run(ancestor)
    const hidden = await f.input('hidden branch')
    f.run(hidden)
    f.conversations.createBranch({ id: 'fork', conversationId: 'task', parentBranchId: 'task-branch', forkedFromMessageId: ancestor.message.id, createdAt: '2026-10-24T00:10:00.000Z', activate: true })
    const current = await f.input('<svg xmlns="http://www.w3.org/2000/svg"/>', { branchId: 'fork', name: 'diagram.svg', mimeType: 'image/svg+xml' })
    const runId = f.run(current)
    const future = await f.input('future', { branchId: 'fork' })
    f.run(future, false)
    const other = await f.input('other task', { conversationId: 'other' })
    f.run(other, false)
    const scope = f.references.activeScope('task', runId)!
    const first = f.references.attachmentSnapshots(scope, { limit: 1 })
    const second = f.references.attachmentSnapshots(scope, { offset: 1, limit: 1 })
    expect(first).toMatchObject({ total: 2, items: [{ sourceMessageId: current.message.id, referenceId: current.resourceId }] })
    expect(second).toMatchObject({ total: 2, items: [{ sourceMessageId: ancestor.message.id, referenceId: ancestor.resourceId }] })
    const access = f.access()
    expect(access.list({ limit: 1 })).toMatchObject({ total: 2, nextOffset: 1 })
    expect(access.list({ offset: 1, limit: 1 })).toMatchObject({ total: 2, nextOffset: null })
    expect((await access.readMaterial(identity(current))).text).toContain('<svg')
    for (const input of [hidden, future, other])
      await expect(access.readMaterial(identity(input))).rejects.toThrow('REFERENCE_NOT_AUTHORIZED')
  })

  it('keeps message identity distinct when resource ids are reused and rejects another task ownership', async () => {
    const f = await fixture()
    const first = await f.input('earlier snapshot', { resourceId: 'same-resource' })
    f.run(first)
    const second = await f.input('later snapshot', { resourceId: 'same-resource' })
    const runId = f.run(second)
    expect(first.record.id).not.toBe(second.record.id)
    expect((await f.access().readMaterial(identity(first))).text).toBe('earlier snapshot')
    expect((await f.access().readMaterial(identity(second))).text).toBe('later snapshot')
    const other = await f.input('another task secret', { conversationId: 'other' })
    f.run(other, false)
    f.database.prepare('UPDATE messages SET content_json = json_set(content_json, \'$.resourceSnapshots[0].attachmentId\', ?) WHERE id = ?').run(other.record.id, second.message.id)
    const page = f.references.attachmentSnapshots(f.references.activeScope('task', runId)!, {})
    expect(page).toMatchObject({ total: 1, items: [{ sourceMessageId: first.message.id }] })
    await expect(f.access().readMaterial(identity(second))).rejects.toThrow('REFERENCE_NOT_AUTHORIZED')
  })

  it('reads only validated projection metadata with message ownership and deferred bindings', async () => {
    const f = await fixture()
    const input = await f.input('snapshot')
    f.database.prepare('UPDATE messages SET content_json = json_set(content_json, \'$.materialProjection\', json(?)) WHERE id = ?').run(JSON.stringify({ deferredReferences: false, deferredResourceIds: [input.resourceId] }), input.message.id)
    const projection = f.references.inputProjection('task', input.message.id)
    expect(projection).toEqual({ materialProjection: { deferredReferences: false, deferredResourceIds: [input.resourceId] }, resourceSnapshots: [{ resourceId: input.resourceId, attachmentId: input.record.id }] })
    expect(projection).not.toHaveProperty('userContent')
    expect(f.references.inputProjection('other', input.message.id)).toBeNull()
    f.database.prepare('UPDATE messages SET content_json = json_set(content_json, \'$.materialProjection.deferredResourceIds\', json(?)) WHERE id = ?').run(JSON.stringify(['unbound-resource']), input.message.id)
    expect(f.references.inputProjection('task', input.message.id)).toBeNull()
    f.database.prepare('UPDATE messages SET content_json = json_set(content_json, \'$.materialProjection\', ?) WHERE id = ?').run('invalid projection', input.message.id)
    expect(f.references.inputProjection('task', input.message.id)).toBeNull()
  })

  it.each(['abort', 'run completed', 'message deleted'])('revalidates %s after asynchronous snapshot reading', async (change) => {
    const f = await fixture()
    const input = await f.input('Private saved bytes')
    const runId = f.run(input)
    let signalRead!: () => void
    let releaseRead!: () => void
    const started = new Promise<void>((resolve) => {
      signalRead = resolve
    })
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const access = f.access({
      getInputMetadata: (...args) => f.attachments.getInputMetadata(...args),
      readText: async (...args) => {
        const text = await f.attachments.readText(...args)
        signalRead()
        await gate
        return text
      },
    })
    const pending = access.readMaterial(identity(input))
    await started
    if (change === 'abort')
      f.controller.abort()
    if (change === 'run completed')
      f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run(runId)
    if (change === 'message deleted')
      f.database.prepare('DELETE FROM messages WHERE id = ?').run(input.message.id)
    releaseRead()
    await expect(pending).rejects.toThrow()
  })
})
