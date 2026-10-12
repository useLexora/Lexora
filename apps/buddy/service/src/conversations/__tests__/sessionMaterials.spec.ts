import type { ExtensionAPI, ExtensionToolContext, ToolCallEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SessionReferenceSource } from '../sessionReferenceToolContract'
import { Buffer } from 'node:buffer'
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { createBuddyInputReference, createBuddyInputReferenceMessage } from '../../agent/context/BuddyInputReference'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { RunEventProjector } from '../../events/RunEventProjector'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { createConversationTreeRepository } from '../../storage/conversationTreeRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { searchConversationHistory } from '../searchConversationHistory'
import { createSessionReferenceCapability } from '../sessionReferenceExtension'
import { SessionReferenceService } from '../SessionReferenceService'
import { SESSION_READ_TOOL, SESSION_SEARCH_TOOL } from '../sessionReferenceToolContract'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-session-materials-')))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  cleanups.push(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const conversations = createConversationRepository(database)
  const attachments = createAttachmentRepository(database)
  const artifacts = new ArtifactService({ repository: createArtifactRepository(database) })
  const publications = createConversationTreeRepository(database)
  const projector = new RunEventProjector(database)
  const services = { conversations, attachments, artifacts, publications }
  const service = new SessionReferenceService(services)
  const now = '2026-01-01T00:00:00.000Z'
  for (const id of ['current', 'source', 'other'])
    conversations.create({ id, branchId: `${id}-branch`, title: id, spaceId: null, approvalPolicy: 'policy', executionProfile: 'read_only', createdAt: now })
  let sequence = 0
  function message(content: unknown, options: { branchId?: string, conversationId?: string, role?: 'user' | 'assistant', runId?: string } = {}) {
    sequence++
    const conversationId = options.conversationId ?? 'source'
    return conversations.createMessage({ id: `message-${sequence}`, conversationId, branchId: options.branchId ?? `${conversationId}-branch`, runId: options.runId ?? null, role: options.role ?? 'user', content, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString() })
  }
  async function inputResource(name: string, content: string | Buffer, options: { branchId?: string, snapshot?: boolean } = {}) {
    const path = join(root, name)
    await writeFile(path, content)
    const resourceId = `resource-${sequence + 1}`
    const attachmentId = `attachment-${sequence + 1}`
    const snapshotPath = join(root, attachmentId)
    if (options.snapshot)
      await writeFile(snapshotPath, content)
    const msg = message({
      userContent: { ...createBuddyUserContent('Use this input.'), panelResourceIds: [resourceId] },
      resourceSnapshots: [{ resourceId, ...(options.snapshot ? { attachmentId } : {}), localReference: { path, name, kind: 'file', mimeType: name.endsWith('.png') ? 'image/png' : 'text/plain', sizeBytes: Buffer.byteLength(content) } }],
    }, { branchId: options.branchId })
    if (options.snapshot)
      attachments.create({ id: attachmentId, conversationId: 'source', createdAt: now, draftId: null, messageId: msg.id, storedPath: snapshotPath, name, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(content) })
    return { path, snapshotPath, message: msg, source: { kind: 'resource' as const, messageId: msg.id, resourceId } }
  }
  async function artifact(name: string, content: string, branchId = 'source-branch') {
    const path = join(root, name)
    await writeFile(path, content)
    const trigger = message('Create a deliverable.', { branchId })
    const runId = `run-${trigger.id}`
    createRunRepository(database).create({ id: runId, conversationId: 'source', branchId, triggeringMessageId: trigger.id, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'completed', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'read_only', startedAt: now })
    const early = message('Early segment.', { branchId, runId, role: 'assistant' })
    const [record] = await artifacts.presentOutputs({ conversationId: 'source', cwd: root, grants: [{ canonicalRoot: root, root, grantId: 'source', kind: 'workspace' }], paths: [path] })
    projector.project([{ runId, sequence: 1, type: 'output.produced', createdAt: now, payload: { artifactIds: [record!.id], sourceToolCallId: `call-${runId}`, sourceToolName: 'lexora_output_present' } }])
    message('Delivered.', { branchId, runId, role: 'assistant' })
    return { path, early, source: { kind: 'artifact' as const, artifactId: record!.id } }
  }
  const input = message({ userContent: { ...createBuddyUserContent('Use source.'), sessionReferences: [{ id: 'source', title: 'source' }] }, resourceSnapshots: [] }, { conversationId: 'current' })
  const capability = createSessionReferenceCapability({ ...services, conversationId: 'current' })
  const tools = new Map<string, ToolDefinition>()
  const hooks = new Map<string, (input: unknown) => unknown>()
  await capability.extension.factory({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (name: string, handler: (input: unknown) => unknown) => hooks.set(name, handler),
  } as unknown as ExtensionAPI)
  await hooks.get('context')!({ messages: [createBuddyInputReferenceMessage(createBuddyInputReference({ messageId: input.id, prompt: 'Use source.', images: [] }), Date.now())] })
  const controller = new AbortController()
  const run = { runId: 'run-current', signal: controller.signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }
  const authorization = new ToolAuthorizationService({
    approvalService: { request: async () => ({ approvalId: 'denied', decision: 'denied' }) },
    approvalAvailable: true,
    approvalPolicy: 'policy',
    executionProfile: 'read_only',
    cwd: root,
    owner: { id: 'current', kind: 'conversation' },
    getGrants: () => [],
  })
  let callId = 0
  async function call(name: string, args: Record<string, unknown>) {
    const event: ToolCallEvent = { type: 'tool_call', toolName: name, input: args, toolCallId: `call-${++callId}` }
    const classification = await capability.classify(event, controller.signal)
    if (classification && 'blocked' in classification)
      throw new Error(classification.reason)
    const reason = await authorization.authorize(event, run, classification ?? {})
    if (reason)
      throw new Error(reason)
    return tools.get(name)!.execute(event.toolCallId, args, controller.signal, undefined, { cwd: root } as ExtensionToolContext)
  }
  async function read(source: SessionReferenceSource, options: { offset?: number, limit?: number, sessionId?: string } = {}) {
    return call(SESSION_READ_TOOL, { sessionId: 'source', source, ...options })
  }
  return { root, conversations, service, controller, call, read, message, inputResource, artifact, capability, tools, hooks }
}

function textResult(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  return JSON.parse(result.content.find(item => item.type === 'text')!.text)
}

describe('referenced task materials', () => {
  it('does not expose a later artifact from the same multi-segment run after branching at its early answer', async () => {
    const f = await fixture()
    const output = await f.artifact('late-private-branch-output.txt', 'LATE_BRANCH_ARTIFACT')
    f.conversations.createBranch({ id: 'early-fork', conversationId: 'source', parentBranchId: 'source-branch', forkedFromMessageId: output.early.id, createdAt: '2026-02-01T00:00:00.000Z', activate: true })
    const search = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', kind: 'resources' }))
    expect(search.resources).toEqual([])
    await expect(f.read(output.source)).rejects.toThrow('SOURCE_UNAVAILABLE')
  })

  it('reads exact long message text across pages with visible neighbouring context', async () => {
    const f = await fixture()
    f.message('Original requirement')
    const text = `早期方案 ${'完整文本🎵'.repeat(6000)} FINAL_DECISION`
    const msg = f.message({ text }, { role: 'assistant' })
    const correction = f.message('Correction: use the revised version.')
    const match = (await searchConversationHistory(f.conversations, f.service.requireSession('source'), { query: 'FINAL_DECISION' })).matches[0]!
    expect(textResult(await f.read(match.source, { offset: match.offset })).text).toContain('FINAL_DECISION')
    const source = { kind: 'message' as const, messageId: msg.id }
    let collected = ''
    let offset = 0
    do {
      const result = textResult(await f.read(source, { offset, limit: 4000 }))
      collected += result.text
      expect(result.after[0].source.messageId).toBe(correction.id)
      if (result.nextOffset === null)
        break
      offset = result.nextOffset
    } while (true)
    expect(collected).toBe(text)
    await expect(f.read(source, { offset: text.length + 1 })).rejects.toThrow('OFFSET_OUT_OF_RANGE')
  })

  it('finds attachments and delivered artifacts absent from message text, and reads every character of a single-line HTML file', async () => {
    const f = await fixture()
    const input = await f.inputResource('reference-notes.txt', 'saved attachment', { snapshot: true })
    await writeFile(input.path, 'changed original')
    const html = `<!doctype html>${'<circle/>'.repeat(10000)}END_OF_HTML`
    const output = await f.artifact('goose-animation.html', html)
    const search = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', query: 'goose-animation' }))
    expect(search.matches).toEqual([])
    expect(search.resources).toHaveLength(1)
    expect(search.resources[0].source).toEqual(output.source)
    let content = ''
    let offset = 0
    do {
      const result = textResult(await f.read(output.source, { offset }))
      content += result.text
      if (result.nextOffset === null)
        break
      offset = result.nextOffset
    } while (true)
    expect(content).toBe(html)
    const saved = textResult(await f.read(input.source))
    expect(saved).toMatchObject({ text: 'saved attachment', storage: 'snapshot' })
    expect(saved).not.toHaveProperty('path')
  })

  it('paginates resource metadata without losing entries and does not expose stored attachment paths', async () => {
    const f = await fixture()
    for (let index = 0; index < 23; index++)
      await f.inputResource(`notes-${index}.txt`, 'saved', { snapshot: true })
    const first = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', kind: 'resources' }))
    const second = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', kind: 'resources', resourceOffset: first.nextResourceOffset }))
    expect(first.resources).toHaveLength(20)
    expect(second.resources).toHaveLength(3)
    expect(second.nextResourceOffset).toBeNull()
    expect(new Set([...first.resources, ...second.resources].map((item: { source: { resourceId: string } }) => item.source.resourceId)).size).toBe(23)
    expect(JSON.stringify(first)).not.toContain(f.root)
  })

  it('keeps only active branch resources, rejects guessed sources, and revokes access on deletion', async () => {
    const f = await fixture()
    const shared = await f.inputResource('shared.txt', 'shared')
    const abandoned = await f.artifact('abandoned.html', 'old branch')
    f.conversations.createBranch({ id: 'fork', conversationId: 'source', parentBranchId: 'source-branch', forkedFromMessageId: shared.message.id, createdAt: '2026-02-01T00:00:00.000Z', activate: true })
    const current = await f.artifact('current.html', 'new branch', 'fork')
    const results = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', kind: 'resources' }))
    expect(results.resources.map((item: { name: string }) => item.name).sort()).toEqual(['current.html', 'shared.txt'])
    await expect(f.read(abandoned.source)).rejects.toThrow('SOURCE_UNAVAILABLE')
    await expect(f.read(current.source, { sessionId: 'other' })).rejects.toThrow('NOT_AUTHORIZED')
    await expect(f.read({ ...shared.source, messageId: 'guessed' })).rejects.toThrow('SOURCE_UNAVAILABLE')
    f.conversations.markDeleted('source', '2026-02-01T00:00:01.000Z')
    await expect(f.read(shared.source)).rejects.toThrow('SESSION_REFERENCE_UNAVAILABLE')
  })

  it('uses the normal read permission checks and revalidates redirected paths before execution', async () => {
    const f = await fixture()
    const secret = await f.inputResource('.env', 'SYNTHETIC_SECRET=fixture')
    await expect(f.read(secret.source)).rejects.toThrow('APPROVAL_DENIED')
    const publicFile = await f.inputResource('public.txt', 'public data')
    const alias = await f.inputResource('alias.txt', 'placeholder')
    await unlink(alias.path)
    await symlink(publicFile.path, alias.path)
    const input = { sessionId: 'source', source: alias.source }
    const classification = await f.capability.classify({ type: 'tool_call', toolCallId: 'swapped', toolName: SESSION_READ_TOOL, input }, f.controller.signal)
    expect(classification).toMatchObject({ access: 'read', paths: [{ path: alias.path, mode: 'existing' }] })
    await unlink(alias.path)
    await symlink(secret.path, alias.path)
    if (!classification || 'blocked' in classification)
      throw new Error('Expected a read classification')
    expect(await classification.validateBeforeExecution!()).toMatchObject({ blocked: true, reason: 'SESSION_REFERENCE_SOURCE_CHANGED' })
    await expect(f.tools.get(SESSION_READ_TOOL)!.execute('swapped', input, f.controller.signal, undefined, { cwd: f.root } as ExtensionToolContext)).rejects.toThrow('SOURCE_CHANGED')
    await unlink(publicFile.path)
    await expect(f.read(publicFile.source)).rejects.toThrow()
    f.controller.abort()
    await expect(f.read(secret.source)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('returns images through the native reader and reports unsupported documents without pretending to extract text', async () => {
    const f = await fixture()
    const image = await f.inputResource('pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AP8AAP8AAP//D/kD/aYucFEAAAAASUVORK5CYII=', 'base64'))
    expect((await f.read(image.source)).content).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png' }))
    const pdf = await f.inputResource('reference.pdf', '%PDF-1.7\nSYNTHETIC_DOCUMENT_BODY')
    const result = textResult(await f.read(pdf.source))
    expect(result.text).toContain('no file content was extracted')
    expect(result.text).not.toContain('SYNTHETIC_DOCUMENT_BODY')
  })
})
