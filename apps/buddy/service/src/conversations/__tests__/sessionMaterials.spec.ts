import type { ExtensionAPI, ExtensionToolContext, ToolCallEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SessionReferenceSource } from '../sessionReferenceToolContract'
import { Buffer } from 'node:buffer'
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { modelFailureFeedback } from '../../../../shared/providers/modelFailureFeedback'
import { createBuddyInputReference, createBuddyInputReferenceMessage } from '../../agent/context/BuddyInputReference'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { RunEventProjector } from '../../events/RunEventProjector'
import { PermissionEngine } from '../../permissions/PermissionEngine'
import { createSensitivePathMatcher } from '../../permissions/sensitivePaths'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { createConversationTreeRepository } from '../../storage/conversationTreeRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunRepository } from '../../storage/runRepository'
import { createSessionReferenceRepository } from '../../storage/sessionReferenceRepository'
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
  const references = createSessionReferenceRepository(database)
  const services = { conversations, attachments, artifacts, publications, references }
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
    engine: new PermissionEngine({ sensitive: createSensitivePathMatcher({ additionalRoots: [join(root, '.env')] }) }),
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
  async function nextInput() {
    const next = message({ userContent: createBuddyUserContent('Continue'), resourceSnapshots: [] }, { conversationId: 'current' })
    await hooks.get('context')!({ messages: [createBuddyInputReferenceMessage(createBuddyInputReference({ messageId: next.id, prompt: 'Continue', images: [] }), Date.now())] })
  }
  function failedTurn(code: string, launchFailure?: { version: number, code: string, location: string }, errorMessage = 'PRIVATE_PROVIDER_EXCEPTION') {
    const trigger = message('Try the local model')
    const runId = `run-${trigger.id}`
    const { branchId, conversationId, createdAt } = trigger
    createRunRepository(database).create({ id: runId, conversationId, branchId, triggeringMessageId: trigger.id, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'read_only', startedAt: createdAt })
    const reply = (sequence: number, text: string, stopReason: string) => {
      const messageId = `${runId}-reply-${sequence}`
      projector.project([{ runId, sequence, createdAt: new Date(Date.parse(createdAt) + sequence).toISOString(), type: 'message.completed', payload: { messageId, role: 'assistant', stopReason, content: { text } } }])
      return { kind: 'message' as const, messageId }
    }
    const early = reply(1, 'Preparing the request.', 'tool_use')
    const retried = reply(2, '', 'failed')
    const terminal = reply(3, '', 'failed')
    projector.project([{ runId, sequence: 4, createdAt: new Date(Date.parse(createdAt) + 4).toISOString(), type: 'run.failed', payload: { errorCode: code, errorMessage, ...(launchFailure ? { launchFailure } : {}) } }])
    return { early, retried, terminal }
  }
  return { nextInput, root, conversations, references, service, controller, call, read, message, inputResource, artifact, capability, tools, hooks, failedTurn }
}

function textResult(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  return JSON.parse(result.content.find(item => item.type === 'text')!.text)
}

describe('referenced task materials', () => {
  it('discovers only directly referenced tasks on demand and preserves chain references in search results', async () => {
    const f = await fixture()
    f.message({ userContent: { ...createBuddyUserContent('Continue earlier work.'), sessionReferences: [{ id: 'other', title: 'other' }] }, resourceSnapshots: [] })
    await f.nextInput()
    expect(textResult(await f.call(SESSION_SEARCH_TOOL, {})).directReferences).toEqual([{ sessionId: 'source', title: 'source', branchId: 'source-branch' }])
    const result = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', query: 'Referenced tasks' }))
    expect(result.matches[0].sessionReferences).toEqual([{ id: 'other', title: 'other' }])
    expect(textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'other' })).sessionId).toBe('other')
    await expect(f.call(SESSION_SEARCH_TOOL, { query: 'needle' })).rejects.toThrow('VALIDATION_FAILED')
  })

  it('does not expose a later artifact from the same multi-segment run after branching at its early answer', async () => {
    const f = await fixture()
    const output = await f.artifact('late-private-branch-output.txt', 'LATE_BRANCH_ARTIFACT')
    f.conversations.createBranch({ id: 'early-fork', conversationId: 'source', parentBranchId: 'source-branch', forkedFromMessageId: output.early.id, createdAt: '2026-02-01T00:00:00.000Z', activate: true })
    await expect(f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', kind: 'resources' })).rejects.toThrow('BRANCH_CHANGED')
    await f.nextInput()
    const search = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', kind: 'resources' }))
    expect(search.resources).toEqual([])
    await expect(f.read(output.source)).rejects.toThrow('SOURCE_UNAVAILABLE')
  })

  it('discovers a terminal model failure without attributing a host diagnostic to model text or earlier attempts', async () => {
    const f = await fixture()
    const code = 'MODEL_LAUNCH_QUOTA_EXCEEDED'
    const location = '<profile>/cache/extensions/referenced.plugin/launches'
    const record = { version: 1, code, location }
    const { early, retried, terminal } = f.failedTurn(code, record)
    const hostFailure = modelFailureFeedback(code, record)
    expect(hostFailure?.location).toBe(location)
    const search = async (query?: string) => textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', query, kind: 'messages' }))
    for (const query of [code, 'quota exceeded', '失败', location]) {
      const result = await search(query)
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]).toMatchObject({ source: terminal, excerpt: '', offset: 0, hostFailure })
    }
    const nearby = textResult(await f.read(early))
    expect(nearby).not.toHaveProperty('hostFailure')
    expect(nearby.after[0].source).toEqual(retried)
    expect(nearby.after[0]).not.toHaveProperty('hostFailure')
    expect(nearby.after[1]).toMatchObject({ source: terminal, excerpt: '', hostFailure })
    const failure = textResult(await f.read(terminal))
    expect(failure).toMatchObject({ text: '', totalCharacters: 0, nextOffset: null, hostFailure })
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_PROVIDER_EXCEPTION')
    expect((await search('PRIVATE_PROVIDER_EXCEPTION')).matches).toEqual([])
    for (let i = 0; i < 8; i++) f.message(`Later note ${i}`)
    const page = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', kind: 'messages' }))
    const next = textResult(await f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', branchId: page.branchId, kind: 'messages', messageOffset: page.nextMessageOffset }))
    expect(next.matches[0]).toMatchObject({ source: terminal, excerpt: '', hostFailure })
    f.conversations.createBranch({ id: 'before-failure', conversationId: 'source', parentBranchId: 'source-branch', forkedFromMessageId: early.messageId, createdAt: '2026-02-01T00:00:00.000Z', activate: true })
    await expect(f.read(terminal)).rejects.toThrow('BRANCH_CHANGED')
    await f.nextInput()
    expect((await search(code)).matches).toEqual([])
    expect(textResult(await f.read(early))).not.toHaveProperty('hostFailure')
    await expect(f.read(terminal)).rejects.toThrow('SOURCE_UNAVAILABLE')
  })

  it('does not derive a directory from a legacy launch code or arbitrary failure text', async () => {
    const f = await fixture()
    const code = 'MODEL_LAUNCH_NO_SPACE'
    for (const detail of ['EXTENSION_INFERENCE_LAUNCH_NO_SPACE', 'PRIVATE_PROVIDER_EXCEPTION']) {
      const { terminal } = f.failedTurn(code, undefined, detail)
      const result = textResult(await f.read(terminal))
      expect(result.hostFailure).toMatchObject({ stage: 'launch', reason: 'no_space', location: 'unknown' })
      expect(JSON.stringify(result)).not.toContain(detail)
    }
  })

  it('returns only the known legacy failure across a visible branch fork', async () => {
    const f = await fixture()
    const { terminal } = f.failedTurn('MODEL_REQUEST_FAILED')
    f.conversations.createBranch({ id: 'after-failure', conversationId: 'source', parentBranchId: 'source-branch', forkedFromMessageId: terminal.messageId, createdAt: '2026-02-01T00:00:00.000Z', activate: true })
    await f.nextInput()
    const { hostFailure } = textResult(await f.read(terminal))
    expect(hostFailure).toMatchObject({ code: 'MODEL_REQUEST_FAILED', stage: 'unknown', reason: 'unknown', location: 'unknown' })
    expect(hostFailure.summary).not.toMatch(/launch|quota/i)
    await expect(f.read(terminal, { sessionId: 'other' })).rejects.toThrow('NOT_AUTHORIZED')
  })

  it('reads exact long message text across pages with visible neighbouring context', async () => {
    const f = await fixture()
    f.message('Original requirement')
    const text = `早期方案 ${'完整文本🎵'.repeat(6000)} FINAL_DECISION`
    const msg = f.message({ text }, { role: 'assistant' })
    const correction = f.message('Correction: use the revised version.')
    const match = (await searchConversationHistory(f, f.service.requireSession('source'), { query: 'FINAL_DECISION' })).matches[0]!
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
    await expect(f.call(SESSION_SEARCH_TOOL, { sessionId: 'source', kind: 'resources' })).rejects.toThrow('BRANCH_CHANGED')
    await f.nextInput()
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
