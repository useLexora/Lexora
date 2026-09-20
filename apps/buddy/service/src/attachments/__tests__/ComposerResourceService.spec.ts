import type { DatabaseSync } from 'node:sqlite'
import type { BuddyUserContentV1 } from '../../../../shared/conversation/buddyUserContent'
import type { BuddyComposerDraftScope } from '../../../../shared/conversation/composerDraft'
import type { InputModel } from '../../providers/modelCapabilities'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUDDY_ATTACHMENT_COUNT_LIMIT } from '../../../../shared/conversation/attachmentPolicy'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { createBuddyInputReference } from '../../agent/context/BuddyInputReference'
import { BuddySessionRecoveryService } from '../../agent/sessions/recovery/BuddySessionRecoveryService'
import { BuddyConversationTree } from '../../agent/sessions/tree/BuddyConversationTree'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { BUDDY_REVIEW_PROMPT } from '../../chat/buddyReviewPrompt'
import { ChatInputValidationService } from '../../chat/ChatInputValidationService'
import { ChatQueueService } from '../../chat/ChatQueueService'
import { ChatTurnService } from '../../chat/ChatTurnService'
import { SpaceService } from '../../spaces/SpaceService'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createChatQueueRepository } from '../../storage/chatQueueRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createComposerResourceRepository } from '../../storage/composerResourceRepository'
import { createConversationDirectoryGrantRepository } from '../../storage/conversationDirectoryGrantRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { createConversationTreeRepository } from '../../storage/conversationTreeRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createSpaceRepository } from '../../storage/spaceRepository'
import { createTurnRequestRepository } from '../../storage/turnRequestRepository'
import { createUsageRepository } from '../../storage/usageRepository'
import { normalizeComposerWorkspace } from '../../workspace/normalizeComposerWorkspace'
import { AttachmentService, normalizeAttachmentMetadata } from '../AttachmentService'
import { AttachmentToolWorkspace } from '../AttachmentToolWorkspace'
import { ComposerResourceService } from '../ComposerResourceService'

const databases: DatabaseSync[] = []
const directories: string[] = []

describe('attachment validation errors', () => {
  it.each([
    [{ name: 'archive.zip', mimeType: 'application/zip', sizeBytes: 10 }, 'ATTACHMENT_UNSUPPORTED'],
    [{ name: 'audio.m4a', mimeType: 'audio/x-m4a', sizeBytes: 10 * 1024 * 1024 + 1 }, 'ATTACHMENT_TOO_LARGE'],
    [{ name: 'audio.m4a', mimeType: 'audio/x-m4a', sizeBytes: 0 }, 'ATTACHMENT_INVALID'],
  ])('distinguishes rejected file metadata', (metadata, code) => {
    expect(() => normalizeAttachmentMetadata(metadata)).toThrow(expect.objectContaining({ code }))
  })

  it('normalizes M4A from the extension and rejects mismatched bytes without publishing an attachment', async () => {
    const { service, drafts, repository } = await setup()
    drafts.open({ draftId: 'invalid-audio', initialContent: createBuddyUserContent(), initialExecutionConfig: { executionProfile: 'read_only', approvalPolicy: 'manual' }, initialModelSelection: null, now: '2026-09-12T00:00:00.000Z', scope: { kind: 'global' } })
    const metadata = { resourceId: 'invalid-audio-resource', name: 'voice.m4a', mimeType: 'audio/x-m4a', sizeBytes: 4 }
    expect((await service.accept({ draftId: 'invalid-audio', resources: [metadata] }))[0]).toMatchObject({ mimeType: 'audio/mp4', kind: 'audio' })
    await expect(service.complete({ draftId: 'invalid-audio', resourceId: metadata.resourceId, bytes: Uint8Array.of(0, 1, 2, 3) })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
    expect(repository.listForDraft('invalid-audio')[0]).not.toMatchObject({ state: 'ready' })
  })
})
afterEach(async () => {
  databases.splice(0).forEach(database => database.close())
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'buddy-composer-resource-'))
  directories.push(root)
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const paths = new BuddyDataPaths(root)
  const repository = createComposerResourceRepository(database)
  const attachmentRepository = createAttachmentRepository(database)
  const attachments = new AttachmentService({ paths, repository: attachmentRepository })
  const drafts = createComposerDraftRepository(database)
  const spaces = createSpaceRepository(database)
  const conversations = createConversationRepository(database)
  const conversationGrants = createConversationDirectoryGrantRepository(database)
  const artifacts = new ArtifactService({ repository: createArtifactRepository(database) })
  const events: Array<{ createdAt: string, payload: unknown, runId: string, sequence: number, type: string }> = []
  return {
    artifacts,
    attachments,
    attachmentRepository,
    conversations,
    conversationGrants,
    database,
    drafts,
    events,
    paths,
    repository,
    root,
    service: new ComposerResourceService({
      artifacts,
      attachments,
      conversationGrants,
      conversations,
      drafts,
      eventLog: { listForRuns: runIds => events.filter(event => runIds.includes(event.runId)) as never },
      paths,
      repository,
      spaces,
    }),
    spaces,
  }
}

function imageBytes() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AP8AAP8AAP//D/kD/aYucFEAAAAASUVORK5CYII=', 'base64')
}

describe('attachment submission validation', () => {
  it('reserves existing snapshots before optional native copies regardless of resource order', async () => {
    const fixture = await setup()
    const bytes = Buffer.alloc(8 * 1024 * 1024)
    bytes.write('RIFF')
    bytes.write('WAVE', 8)
    for (const id of ['b-copy', 'c-copy', 'd-copy']) {
      await fixture.service.accept({ draftId: 'budget', resources: [{ resourceId: id, name: `${id}.wav`, mimeType: 'audio/wav', sizeBytes: bytes.length }] })
      await fixture.service.complete({ draftId: 'budget', resourceId: id, bytes })
    }
    const local = join(fixture.root, 'local.wav')
    await writeFile(local, bytes)
    await truncate(local, 10 * 1024 * 1024)
    await fixture.service.selectSource({ draftId: 'budget', resourceId: 'a-local', source: { localPath: local } })
    const result = await fixture.service.resolveInput('budget', { ...createBuddyUserContent(), panelResourceIds: ['a-local', 'b-copy', 'c-copy', 'd-copy'] }, { branchId: null, conversationId: null, spaceId: null }, { api: 'openai-completions', input: ['text'], fileInputMimeTypes: ['audio/wav'] })
    expect(result.map(resource => resource.resourceId)).toEqual(['a-local', 'b-copy', 'c-copy', 'd-copy'])
    expect(result[0]).toMatchObject({ localReference: { path: local } })
    expect(result[0]!.attachmentId).toBeUndefined()
    expect(result.slice(1).every(resource => resource.attachmentId)).toBe(true)
    expect(fixture.attachmentRepository.listDraftsBefore('9999')).toHaveLength(3)
  })
  it.each([false, true])('keeps the queued snapshot when revalidation fails before dispatch or steering (active: %s)', async (active) => {
    const fixture = await checkedTurns({ api: 'openai-completions' })
    fixture.control.completeRuns = !active
    const bytes = Buffer.alloc(8 * 1024 * 1024)
    bytes.write('RIFF')
    bytes.write('WAVE', 8)
    const first = await fixture.draft('first', 'first.wav', bytes)
    const started = await fixture.turns.start({ draftId: first.draftId, expectedRevision: first.revision, requestId: 'first' })
    const second = await fixture.draft('second', 'second.wav', bytes, { kind: 'conversation_branch', conversationId: started.conversationId, branchId: started.branchId })
    const repository = createChatQueueRepository(fixture.database)
    const queue = new ChatQueueService({ runInputs: createRunInputRepository(fixture.database), queue: repository, turns: fixture.turns, runs: fixture.runs, requests: createTurnRequestRepository(fixture.database), launcher: fixture.launcher, runner: { followUp: () => false, steer: (_runId, prepare) => {
      prepare()
      return true
    } } })
    try {
      const queued = await queue.enqueue({ draftId: second.draftId, expectedRevision: second.revision, requestId: 'queued' })
      repository.pause(started.conversationId)
      fixture.model.api = 'google-generative-ai'
      fixture.control.history = [{ role: 'user', content: 'x'.repeat(20 * 1024 * 1024), timestamp: 0 }]
      await expect(queue.steer(queued)).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' })
      expect(repository.list(queued)).toMatchObject([{ id: queued.id, state: 'paused', attachments: [{ sizeBytes: bytes.length, mimeType: 'audio/wav' }] }])
      expect(fixture.runs.listRecent()).toHaveLength(1)
      expect(fixture.runs.findById(started.runId)?.status).toBe(active ? 'running' : 'completed')
      expect(fixture.conversations.listBranchMessages(started.conversationId, started.branchId).filter(message => message.role === 'user')).toHaveLength(1)
    }
    finally {
      queue.dispose()
    }
  })
  it('publishes unsupported M4A as a file resource', async () => {
    const fixture = await checkedTurns({ api: 'openai-completions' })
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypM4A '), Buffer.alloc(8)])
    const draft = await fixture.draft('audio', 'voice.m4a', bytes)
    const turn = await fixture.turns.start({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'unsupported' })
    expect(fixture.runs.listRecent()).toHaveLength(1)
    expect(fixture.attachments.listForConversation(turn.conversationId)).toMatchObject([{ mimeType: 'audio/mp4', sizeBytes: bytes.length }])
    expect(fixture.service.list(draft.draftId)[0]?.state).toBe('ready')
  })

  it('retains an oversized second draft and permits a text-only continuation', async () => {
    const fixture = await checkedTurns()
    const bytes = Buffer.alloc(8 * 1024 * 1024)
    bytes.write('RIFF')
    bytes.write('WAVE', 8)
    const first = await fixture.draft('first', 'first.wav', bytes)
    const started = await fixture.turns.start({ draftId: first.draftId, expectedRevision: first.revision, requestId: 'first' })
    const second = await fixture.draft('second', 'second.wav', bytes, { kind: 'conversation_branch', conversationId: started.conversationId, branchId: started.branchId })
    fixture.control.history = [{ role: 'user', content: 'x'.repeat(20 * 1024 * 1024), timestamp: 0 }]
    await expect(fixture.turns.start({ draftId: second.draftId, expectedRevision: second.revision, requestId: 'second' })).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' })
    expect(fixture.drafts.findById(second.draftId)).toEqual(second)
    expect(fixture.runs.listRecent()).toHaveLength(1)
    const resource = fixture.service.list(second.draftId)[0]!
    expect(resource.state).toBe('ready')
    fixture.control.history = []
    const plain = fixture.drafts.save({ ...second, expectedRevision: second.revision, content: createBuddyUserContent('Continue without another attachment'), now: new Date().toISOString() })
    await expect(fixture.turns.start({ draftId: plain.draftId, expectedRevision: plain.revision, requestId: 'plain' })).resolves.toMatchObject({ conversationId: started.conversationId })
    expect(fixture.runs.listRecent()).toHaveLength(2)
    expect(fixture.conversations.listBranchMessages(started.conversationId, started.branchId).filter(message => message.role === 'user')).toHaveLength(2)
  })
})

async function checkedTurns(overrides: Partial<InputModel> = {}) {
  const fixture = await setup()
  const { database, attachments, conversations, paths } = fixture
  const runs = createRunRepository(database)
  const runInputs = createRunInputRepository(database)
  const model: InputModel = { api: 'google-generative-ai', provider: 'fixture', id: 'fixture', name: 'Fixture', baseUrl: 'https://example.test', contextWindow: 1_000_000, maxTokens: 8192, input: ['text'], audioInput: true, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides }
  const models = { resolve: () => model, resolveAvailable: async () => model, getServiceTiers: () => [] }
  const control = { completeRuns: true, history: [] as { role: 'user', content: string, timestamp: number }[] }
  const launcher = { launch: async (runId: string) => {
    if (!control.completeRuns) {
      runs.markRunning(runId, new Date().toISOString())
      return { runId, completion: new Promise<NonNullable<ReturnType<typeof runs.findById>>>(() => {}) }
    }
    runs.reconcileTerminal(runId, 'completed', new Date().toISOString(), null)
    const run = runs.findById(runId)!
    conversations.createMessage({ id: `answer-${runId}`, conversationId: run.conversationId, branchId: run.branchId, runId, role: 'assistant', content: { text: 'Accepted' }, createdAt: new Date().toISOString() })
    return { runId, completion: Promise.resolve(run) }
  } }
  const recovery = new BuddySessionRecoveryService({ attachments, conversations, models, runs, runInputs, usage: createUsageRepository(database) })
  const tree = new BuddyConversationTree({ conversationsDirectory: paths.conversationsDirectory, conversations, runs, recovery, repository: createConversationTreeRepository(database) })
  const turns = new ChatTurnService({
    inputValidation: new ChatInputValidationService({ attachments, models, paths, recovery, runInputs, runs, tree, sessions: { getReady: () => control.history.length ? { getInputContext: () => ({ messages: control.history }) } as never : null } }),
    attachments,
    composerResources: fixture.service,
    conversations,
    drafts: fixture.drafts,
    spaces: fixture.spaces,
    runs,
    runInputs,
    conversationLifecycle: { isDeleting: () => false },
    providers: { executionModels: models, getDefaultModel: async () => ({ modelId: model.id, providerId: model.provider, reasoning: null, serviceTier: null }) },
    runner: { cancel: async () => false },
    skills: { materializeForSpace: async () => [] },
    turnRequests: createTurnRequestRepository(database),
    turnLauncher: launcher,
  })
  return { ...fixture, turns, runs, model, control, launcher, async draft(id: string, name: string, bytes: Buffer, scope: BuddyComposerDraftScope = { kind: 'global' }) {
    const content = { ...createBuddyUserContent('Inspect the file'), panelResourceIds: [id] }
    const opened = fixture.drafts.open({ draftId: id, initialContent: content, initialExecutionConfig: { approvalPolicy: 'manual', executionProfile: 'read_only' }, initialModelSelection: null, scope, now: new Date().toISOString() })
    const draft = fixture.drafts.save({ ...opened, content, expectedRevision: opened.revision, now: new Date().toISOString() })
    await fixture.service.accept({ draftId: draft.draftId, resources: [{ resourceId: id, name, mimeType: '', sizeBytes: bytes.length }] })
    await fixture.service.complete({ draftId: draft.draftId, resourceId: id, bytes: Uint8Array.from(bytes) })
    return draft
  } }
}

describe('review turn boundaries', () => {
  const executionConfig = { approvalPolicy: 'policy' as const, executionProfile: 'workspace_write' as const }
  function reviewContent(mode: 'text' | 'directive' | 'directive_with_arguments', focus: string): BuddyUserContentV1 {
    if (mode === 'text')
      return createBuddyUserContent(`/review ${focus}`)
    return { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: mode === 'directive'
      ? [
          { type: 'prompt_directive', directive: 'slash_command', commandMode: 'prompt', value: '/review' },
          { type: 'text', text: ` ${focus}` },
        ]
      : [{ type: 'prompt_directive', directive: 'slash_command', commandMode: 'prompt', value: `/review ${focus}` }] }] }
  }

  it.each(['text', 'directive', 'directive_with_arguments'] as const)('keeps reviews read-only through send, edit and regeneration without narrowing the next ordinary turn (%s)', async (mode) => {
    const f = await checkedTurns()
    const inputs = createRunInputRepository(f.database)
    const draft = f.drafts.open({ draftId: 'review-draft', scope: { kind: 'global' }, initialContent: reviewContent(mode, 'first focus'), initialExecutionConfig: executionConfig, initialModelSelection: null, now: new Date().toISOString() })
    const first = await f.turns.start({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'review-start' })
    expect(first.run.executionProfile).toBe('read_only')
    expect(f.conversations.findById(first.conversationId)?.executionProfile).toBe('workspace_write')
    expect(inputs.findByRunId(first.runId)?.prompt.split(BUDDY_REVIEW_PROMPT)).toHaveLength(2)
    expect(inputs.findByRunId(first.runId)?.prompt.split('first focus')).toHaveLength(2)
    const source = f.runs.findById(first.runId)!
    const edit = f.drafts.open({ draftId: 'review-edit', scope: { kind: 'message_edit', conversationId: first.conversationId, branchId: first.branchId, userMessageId: source.triggeringMessageId }, initialContent: reviewContent(mode, 'edited focus'), initialExecutionConfig: executionConfig, initialModelSelection: null, now: new Date().toISOString() })
    const edited = await f.turns.editUserMessage({ conversationId: first.conversationId, userMessageId: source.triggeringMessageId, draftId: edit.draftId, expectedRevision: edit.revision, requestId: 'review-edit' })
    expect(edited.run.executionProfile).toBe('read_only')
    expect(inputs.findByRunId(edited.runId)?.prompt.split(BUDDY_REVIEW_PROMPT)).toHaveLength(2)
    expect(inputs.findByRunId(edited.runId)?.prompt.split('edited focus')).toHaveLength(2)
    expect(f.conversations.listBranchMessages(first.conversationId, first.branchId).find(message => message.id === source.triggeringMessageId)?.content).toMatchObject({ userContent: draft.content })
    const regenerated = await f.turns.regenerateAssistant({ conversationId: first.conversationId, sourceRunId: edited.runId, requestId: 'review-regenerate' })
    expect(regenerated.run.executionProfile).toBe('read_only')
    expect(inputs.findByRunId(regenerated.runId)?.prompt).toBe(inputs.findByRunId(edited.runId)?.prompt)
    const next = f.drafts.open({ draftId: 'ordinary', scope: { kind: 'conversation_branch', conversationId: first.conversationId, branchId: regenerated.branchId }, initialContent: createBuddyUserContent('continue normally'), initialExecutionConfig: executionConfig, initialModelSelection: null, now: new Date().toISOString() })
    const ordinary = await f.turns.start({ draftId: next.draftId, expectedRevision: next.revision, requestId: 'ordinary' })
    expect(ordinary.run.executionProfile).toBe('workspace_write')
    expect(inputs.findByRunId(ordinary.runId)?.prompt).toBe('continue normally')
  })

  it.each([
    ['workspace_write', 'read_only'],
    ['full_access', 'workspace_write'],
  ] as const)('regenerates a %s run under the current narrower %s permission', async (sourceProfile, currentProfile) => {
    const f = await checkedTurns()
    const draft = f.drafts.open({ draftId: 'ordinary', scope: { kind: 'global' }, initialContent: createBuddyUserContent('inspect'), initialExecutionConfig: { ...executionConfig, executionProfile: sourceProfile }, initialModelSelection: null, now: new Date().toISOString() })
    const first = await f.turns.start({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'ordinary' })
    f.conversations.setPermissionSettings({ id: first.conversationId, approvalPolicy: 'policy', executionProfile: currentProfile, updatedAt: new Date().toISOString() })
    const regenerated = await f.turns.regenerateAssistant({ conversationId: first.conversationId, sourceRunId: first.runId, requestId: 'narrowed' })
    expect(regenerated.run.executionProfile).toBe(currentProfile)
    expect(f.runs.findById(first.runId)?.executionProfile).toBe(sourceProfile)
  })

  it.each(['/plan', '/status', '/skills', '/review'])('keeps a legacy %s draft usable without reviving retired prompt behavior', async (command) => {
    const f = await checkedTurns()
    const legacy = { drafts: [{ draftId: 'legacy', targetKey: 'global', composerContent: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'chatPromptToken', attrs: { kind: 'slashCommand', value: command } }] }] } }] }
    const normalized = await normalizeComposerWorkspace(legacy, { resources: f.service, conversations: f.conversations })
    expect(normalized).toMatchObject({ drafts: [{ composerContent: { content: [{ content: [command === '/review'
      ? { type: 'chatPromptDirective', attrs: { directive: 'slash_command', commandMode: 'prompt', value: '/review' } }
      : { type: 'text', text: command }] }] } }] })
    const content: BuddyUserContentV1 = { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'prompt_directive', directive: 'slash_command', commandMode: 'prompt', value: command }] }] }
    const draft = f.drafts.open({ draftId: 'legacy', scope: { kind: 'global' }, initialContent: content, initialExecutionConfig: executionConfig, initialModelSelection: null, now: new Date().toISOString() })
    const turn = await f.turns.start({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'legacy' })
    expect(createRunInputRepository(f.database).findByRunId(turn.runId)?.prompt).toBe(command === '/review' ? BUDDY_REVIEW_PROMPT : command)
    expect(turn.run.executionProfile).toBe(command === '/review' ? 'read_only' : 'workspace_write')
  })
})

describe('attachment working copies', () => {
  it('preserves working edits across restart and restores deleted copies without modifying the snapshot', async () => {
    const fixture = await checkedTurns({ api: 'openai-completions' })
    const bytes = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0])
    const draft = await fixture.draft('video', 'deepseek.webm', bytes)
    const turn = await fixture.turns.start({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'video' })
    const [snapshot] = fixture.attachments.listForConversation(turn.conversationId)
    const scratch = fixture.paths.conversationWorkspace(turn.conversationId)
    await mkdir(scratch, { recursive: true })
    const input = createBuddyInputReference({ attachmentIds: [snapshot!.id], images: [], documents: [], messageId: 'message', prompt: 'Convert to GIF' })
    const workspace = new AttachmentToolWorkspace(scratch)
    const manifest = async (target = workspace) => JSON.parse((await fixture.attachments.materializeInputResources(input, turn.conversationId, target)).split('\n')[1]!) as { path: string, content: string, label: string }[]
    const [resource] = await manifest()
    expect(resource).toMatchObject({ content: 'file_only', label: '[FILE#1]' })
    expect(resource!.path.startsWith(scratch)).toBe(true)
    expect(await readFile(resource!.path)).toEqual(bytes)
    await writeFile(resource!.path, 'edited copy')
    expect((await manifest())[0]!.path).toBe(resource!.path)
    expect(await readFile(snapshot!.storedPath)).toEqual(bytes)
    const [restored] = await manifest(new AttachmentToolWorkspace(scratch))
    expect(restored!.path).toBe(resource!.path)
    expect(await readFile(restored!.path, 'utf8')).toBe('edited copy')
    await rm(restored!.path)
    expect((await manifest())[0]!.path).toBe(restored!.path)
    expect(await readFile(restored!.path)).toEqual(bytes)
    const unsafe = new AttachmentToolWorkspace(scratch)
    const [safe] = await manifest(unsafe)
    await rm(safe!.path)
    await symlink(snapshot!.storedPath, safe!.path)
    await expect(manifest(unsafe)).rejects.toThrow('working copy')
    await rm(dirname(safe!.path), { recursive: true })
    await symlink(dirname(snapshot!.storedPath), dirname(safe!.path))
    await expect(manifest(new AttachmentToolWorkspace(scratch))).rejects.toThrow('directory identity changed')
    expect(await readFile(snapshot!.storedPath)).toEqual(bytes)
  })

  it('keeps message labels when an earlier snapshot is missing during recovery', async () => {
    const fixture = await checkedTurns()
    const bytes = imageBytes()
    const first = await fixture.draft('first', 'first.png', bytes)
    await fixture.service.accept({ draftId: first.draftId, resources: [{ resourceId: 'second', name: 'second.png', mimeType: 'image/png', sizeBytes: bytes.length }] })
    await fixture.service.complete({ draftId: first.draftId, resourceId: 'second', bytes })
    const draft = fixture.drafts.save({ ...first, expectedRevision: first.revision, content: { ...first.content, panelResourceIds: ['first', 'second'] }, now: new Date().toISOString() })
    const turn = await fixture.turns.start({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'two-images' })
    const records = fixture.attachments.listForConversation(turn.conversationId)
    const missing = records.find(record => record.name === 'first.png')!
    const available = records.find(record => record.name === 'second.png')!
    await rm(missing.storedPath)
    const recovery = await fixture.attachments.resolveRecoveryInputReferences([missing.id, available.id], turn.conversationId, 'Inspect the files')
    expect(recovery.missingAttachmentIds).toEqual([missing.id])
    expect(recovery.resourceLabels?.[available.id]).toBe('[FILE#2]')
    const scratch = fixture.paths.conversationWorkspace(turn.conversationId)
    await mkdir(scratch, { recursive: true })
    const input = createBuddyInputReference({ attachmentIds: [available.id], resourceLabels: recovery.resourceLabels, images: [], messageId: 'message', prompt: 'Inspect the files' })
    const manifest = await fixture.attachments.materializeInputResources(input, turn.conversationId, new AttachmentToolWorkspace(scratch))
    expect(JSON.parse(manifest.split('\n')[1]!)).toMatchObject([{ attachmentId: available.id, label: '[FILE#2]' }])
  })

  it('persists anonymous paste provenance while leaving named uploads named', async () => {
    const fixture = await setup()
    const bytes = imageBytes()
    for (const [id, nameSource] of [['paste', 'clipboard'], ['upload', 'file']] as const) {
      await fixture.service.accept({ draftId: 'draft', resources: [{ resourceId: id, name: 'image.png', nameSource, mimeType: 'image/png', sizeBytes: bytes.length }] })
      const ready = await fixture.service.complete({ draftId: 'draft', resourceId: id, bytes })
      expect(ready).toMatchObject({ nameSource })
      if (ready.state !== 'ready' || !('attachmentId' in ready))
        throw new Error('Import failed')
      expect(fixture.attachmentRepository.findById(ready.attachmentId)?.nameSource).toBe(nameSource)
    }
    expect(fixture.service.list('draft').map(resource => resource.nameSource).sort()).toEqual(['clipboard', 'file'])
  })

  it('keeps an explicitly saved copy separate from the original and does not follow it during materialization', async () => {
    const fixture = await checkedTurns()
    const sourcePath = join(fixture.root, 'source.txt')
    await writeFile(sourcePath, 'original')
    await fixture.service.accept({ draftId: 'selected', resources: [{ resourceId: 'selected-file', name: 'source.txt', mimeType: 'text/plain', sizeBytes: 8, sourcePath, storage: 'snapshot' }] })
    const resource = await fixture.service.complete({ draftId: 'selected', resourceId: 'selected-file', bytes: Buffer.from('original') })
    expect(resource).toMatchObject({ nameSource: 'file', sourcePath })
    const draft = fixture.drafts.open({ draftId: 'selected', initialContent: { ...createBuddyUserContent('Edit this file'), panelResourceIds: [resource!.resourceId] }, initialExecutionConfig: { approvalPolicy: 'manual', executionProfile: 'read_only' }, initialModelSelection: null, scope: { kind: 'global' }, now: new Date().toISOString() })
    const turn = await fixture.turns.start({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'selected' })
    const [snapshot] = fixture.attachments.listForConversation(turn.conversationId)
    expect(snapshot?.sourcePath).toBe(sourcePath)
    await writeFile(sourcePath, 'changed source')
    const scratch = fixture.paths.conversationWorkspace(turn.conversationId)
    await mkdir(scratch, { recursive: true })
    const input = createBuddyInputReference({ attachmentIds: [snapshot!.id], images: [], messageId: 'selected', prompt: 'Edit this file' })
    const manifest = JSON.parse((await fixture.attachments.materializeInputResources(input, turn.conversationId, new AttachmentToolWorkspace(scratch))).split('\n')[1]!) as { path: string, sourcePath: string }[]
    expect(manifest[0]!.sourcePath).toBe(sourcePath)
    expect(manifest[0]!.path).not.toBe(sourcePath)
    expect(await readFile(manifest[0]!.path, 'utf8')).toBe('original')
    await writeFile(manifest[0]!.path, 'edited working copy')
    expect(await readFile(sourcePath, 'utf8')).toBe('changed source')
    await rm(sourcePath)
    const replay = await fixture.attachments.materializeInputResources(input, turn.conversationId, new AttachmentToolWorkspace(scratch))
    expect(JSON.parse(replay.split('\n')[1]!)[0].sourcePath).toBe(sourcePath)
  })
})

describe('composer resource import', () => {
  it('distinguishes bound directories from owned execution storage and stale additional grants', async () => {
    const fixture = await setup()
    const primary = join(fixture.root, 'primary')
    const extra = join(fixture.root, 'extra')
    const stale = join(fixture.root, 'removed')
    await mkdir(primary)
    await mkdir(extra)
    await writeFile(join(primary, 'root.txt'), 'root')
    await writeFile(join(extra, 'external.txt'), 'external')
    fixture.spaces.create({ id: 'space', name: 'Space', memoryScope: 'space_only', createdAt: '2026-09-15T00:00:00.000Z', primaryDirectory: { id: 'primary', root: primary, canonicalRoot: primary, accessGrantedAt: 'now', resourcesTrustedAt: 'now' }, additionalDirectories: [{ id: 'extra', root: extra, canonicalRoot: extra, accessGrantedAt: 'now' }, { id: 'stale', root: stale, canonicalRoot: stale, accessGrantedAt: 'now' }] })
    const scope = { draftId: 'draft', spaceId: 'space', conversationId: null, branchId: null, query: '' }
    const catalog = await fixture.service.listSources(scope)
    expect(catalog.directory).toMatchObject({ workingDirectory: primary, path: primary, status: 'ready' })
    expect(catalog.files.map(file => [file.name, file.category])).toEqual([['root.txt', 'space'], ['extra', 'external']])
    const externalRoot = catalog.files.find(file => file.category === 'external')!
    expect((await fixture.service.selectSource({ draftId: 'draft', resourceId: 'directory', source: externalRoot.source })).localReference?.path).toBe(extra)
    const external = await fixture.service.listSources({ ...scope, query: `${extra}/` })
    expect(external.files.map(file => file.name)).toEqual(['external.txt'])
    expect(external.directory).toMatchObject({ workingDirectory: primary, path: extra })
    fixture.spaces.create({ id: 'owned-space', name: 'Owned', memoryScope: 'space_only', createdAt: '2026-09-15T00:00:00.000Z', primaryDirectory: null, additionalDirectories: [{ id: 'removed-extra', root: stale, canonicalRoot: stale, accessGrantedAt: 'now' }] })
    expect(await fixture.service.listSources({ ...scope, spaceId: 'owned-space' })).toEqual({ files: [], directory: undefined })
    const owned = fixture.paths.spaceWorkspace('owned-space')
    await mkdir(owned, { recursive: true })
    await writeFile(join(owned, 'internal.txt'), 'internal')
    expect(await fixture.service.listSources({ ...scope, spaceId: 'owned-space' })).toEqual({ files: [], directory: undefined })
    const explicit = await fixture.service.listSources({ ...scope, spaceId: 'owned-space', query: `${owned}/` })
    expect(explicit.directory).toMatchObject({ path: owned, query: '', status: 'ready' })
    expect(explicit.directory?.workingDirectory).toBeUndefined()
    expect(explicit.files.map(file => [file.name, file.category])).toEqual([['internal.txt', 'external']])
    const empty = join(primary, 'empty')
    await mkdir(empty)
    expect(await fixture.service.listSources({ ...scope, query: `${empty}/` })).toMatchObject({ files: [], directory: { workingDirectory: primary, path: empty, query: '', status: 'ready' } })
    expect(await fixture.service.listSources({ ...scope, query: 'absent-file' })).toMatchObject({ files: [], directory: { workingDirectory: primary, query: 'absent-file', status: 'ready' } })
  })

  it('numbers historical clipboard images in message order, identifies their source message and preserves filenames for uploaded images', async () => {
    const fixture = await setup()
    fixture.conversations.create({ id: 'history', branchId: 'branch', title: 'History', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt: '2026-09-15T00:00:00.000Z' })
    fixture.conversations.createMessage({ id: 'first', conversationId: 'history', branchId: 'branch', role: 'user', runId: null, content: 'Text without files', createdAt: '2026-09-15T00:00:01.000Z' })
    fixture.conversations.createMessage({ id: 'answer', conversationId: 'history', branchId: 'branch', role: 'assistant', runId: null, content: 'Answer', createdAt: '2026-09-15T00:00:02.000Z' })
    const storedPath = join(fixture.root, 'image.png')
    await writeFile(storedPath, imageBytes())
    const ids = ['second-image', 'first-image', 'file-image']
    fixture.conversations.createMessage({ id: 'images', conversationId: 'history', branchId: 'branch', role: 'user', runId: null, createdAt: '2026-09-15T00:00:03.000Z', content: { userContent: { ...createBuddyUserContent(), panelResourceIds: ids }, resourceSnapshots: ids.map(resourceId => ({ resourceId, attachmentId: resourceId })) } })
    for (const id of [...ids].reverse()) {
      const imagePath = join(fixture.root, `${id}.png`)
      await writeFile(imagePath, imageBytes())
      fixture.attachmentRepository.create({ id, messageId: 'images', conversationId: 'history', draftId: null, name: id === 'file-image' ? 'uploaded.png' : 'image.png', nameSource: id === 'file-image' ? 'file' : 'clipboard', mimeType: 'image/png', sizeBytes: imageBytes().length, storedPath: imagePath, createdAt: '2026-09-15T00:00:03.000Z' })
    }
    const scope = { draftId: 'draft', conversationId: 'history', branchId: 'branch', spaceId: null, query: '' }
    const catalog = await fixture.service.listSources(scope)
    expect(catalog.directory).toBeUndefined()
    expect(catalog.files.map(file => [file.label, file.history?.messageNumber])).toEqual([['[Image #1]', 2], ['[Image #2]', 2], ['uploaded.png', 2]])
    const filtered = await fixture.service.listSources({ ...scope, query: 'Image #2' })
    expect(filtered.files).toHaveLength(1)
    expect(filtered.files[0]).toMatchObject({ label: '[Image #2]', source: { messageId: 'images', resourceId: 'first-image' }, history: { messageNumber: 2 } })
    const selected = await fixture.service.selectSource({ draftId: 'draft', resourceId: 'selected-image', source: filtered.files[0]!.source })
    expect(await fixture.service.resolveInput('draft', { ...createBuddyUserContent(), panelResourceIds: [selected.resourceId] }, scope)).toEqual([{ resourceId: selected.resourceId, attachmentId: 'first-image' }])
  })

  it('lists and references directories, AVIF and oversized videos without importing their contents', async () => {
    const fixture = await checkedTurns({ input: ['text', 'image'] })
    const folder = join(fixture.root, 'media folder')
    await mkdir(folder)
    const avif = join(folder, 'doro.avif')
    const video = join(folder, 'large.mp4')
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypavif'), Buffer.alloc(8)])
    await writeFile(avif, bytes)
    await writeFile(video, 'ftyp')
    await truncate(video, 60 * 1024 * 1024)
    const space = await new SpaceService(fixture.spaces).create({ name: 'Media', memoryScope: 'space_only', primaryDirectory: { id: null, root: fixture.root }, primaryDirectorySelectionVerified: true })
    const scope = { branchId: null, conversationId: null, spaceId: space.id }
    const rootCatalog = await fixture.service.listSources({ ...scope, draftId: 'local', query: '' })
    expect(rootCatalog.files).toContainEqual(expect.objectContaining({ name: 'media folder', kind: 'directory' }))
    const children = await fixture.service.listSources({ ...scope, draftId: 'local', query: `${folder}/` })
    expect(children.files.map(file => file.name)).toEqual(['doro.avif', 'large.mp4'])
    const resources = await fixture.service.registerFiles({ draftId: 'local', paths: [folder, avif, video] })
    const draft = fixture.drafts.open({ draftId: 'local', initialContent: { ...createBuddyUserContent('Inspect these originals'), panelResourceIds: resources.map(resource => resource.resourceId) }, initialExecutionConfig: { approvalPolicy: 'manual', executionProfile: 'read_only' }, initialModelSelection: null, scope: { kind: 'space', spaceId: space.id }, now: new Date().toISOString() })
    const turn = await fixture.turns.start({ draftId: draft.draftId, expectedRevision: draft.revision, requestId: 'local' })
    const message = fixture.conversations.listBranchMessages(turn.conversationId, turn.branchId).find(message => message.role === 'user')!
    expect(message.content).toMatchObject({ resourceSnapshots: resources.map(resource => ({ resourceId: resource.resourceId, localReference: resource.localReference })) })
    const runInput = createRunInputRepository(fixture.database).findByRunId(turn.runId)!
    expect(runInput.attachmentIds).toEqual([])
    expect(runInput.prompt).toContain(avif)
    expect(runInput.prompt).toContain('not access grants')
    expect(fixture.attachmentRepository.listDraftsBefore('9999')).toEqual([])
    expect(fixture.attachments.listForConversation(turn.conversationId)).toEqual([])
    expect(await readFile(avif)).toEqual(bytes)
    await fixture.service.cleanupDrafts(new Date('2099-01-01').getTime())
    expect(await readFile(avif)).toEqual(bytes)
  })

  it('automatically freezes supported native inputs and reuses historical snapshots after the original disappears', async () => {
    const fixture = await checkedTurns({ input: ['text', 'image'] })
    const image = join(fixture.root, 'original.png')
    await writeFile(image, imageBytes())
    const [resource] = await fixture.service.registerFiles({ draftId: 'native', paths: [image] })
    const draft = fixture.drafts.open({ draftId: 'native', initialContent: { ...createBuddyUserContent('Look'), panelResourceIds: [resource!.resourceId] }, initialExecutionConfig: { approvalPolicy: 'manual', executionProfile: 'read_only' }, initialModelSelection: null, scope: { kind: 'global' }, now: new Date().toISOString() })
    await expect(fixture.service.resolvePreview({ draftId: 'native', resourceId: resource!.resourceId })).resolves.toEqual({ mimeType: 'image/png', path: image })
    const turn = await fixture.turns.start({ draftId: 'native', expectedRevision: draft.revision, requestId: 'native' })
    const snapshot = fixture.attachments.listForConversation(turn.conversationId)[0]!
    expect(snapshot.sourcePath).toBe(image)
    expect(await readFile(snapshot.storedPath)).toEqual(imageBytes())
    const message = fixture.conversations.listBranchMessages(turn.conversationId, turn.branchId).find(message => message.role === 'user')!
    await rm(image)
    const historical = await fixture.service.selectSource({ draftId: 'edit', resourceId: 'historical', source: { conversationId: turn.conversationId, branchId: turn.branchId, messageId: message.id, resourceId: resource!.resourceId } })
    const resolved = await fixture.service.resolveInput('edit', { ...createBuddyUserContent(), panelResourceIds: [historical.resourceId] }, { conversationId: turn.conversationId, branchId: turn.branchId, spaceId: null }, { api: 'google-generative-ai', input: ['text', 'image'], fileInputMimeTypes: [] })
    expect(resolved).toMatchObject([{ resourceId: 'historical', attachmentId: snapshot.id, localReference: { path: image } }])
    expect(await readFile(snapshot.storedPath)).toEqual(imageBytes())
    await expect(fixture.service.resolveInput('edit', { ...createBuddyUserContent(), panelResourceIds: [historical.resourceId] })).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
  })

  it('keeps unsupported model inputs as local references and accepts mixed batches atomically', async () => {
    const fixture = await setup()
    const path = join(fixture.root, 'image.png')
    await writeFile(path, imageBytes())
    const input = { draftId: 'batch', resources: [{ resourceId: 'one', sourcePath: path, name: 'image.png', mimeType: '', sizeBytes: 0, storage: 'reference' as const }, { resourceId: 'two', sourcePath: path, name: 'image.png', mimeType: '', sizeBytes: 0, storage: 'reference' as const }, { resourceId: 'copy', name: 'note.txt', mimeType: 'text/plain', sizeBytes: 2 }] }
    const accepted = await fixture.service.accept(input)
    expect(accepted.map(resource => resource.resourceId)).toEqual(['one', 'two', 'copy'])
    await fixture.service.complete({ draftId: 'batch', resourceId: 'copy', bytes: Buffer.from('hi') })
    const resolved = await fixture.service.resolveInput('batch', { ...createBuddyUserContent(), panelResourceIds: ['one', 'two', 'copy'] }, { branchId: null, conversationId: null, spaceId: null }, { api: 'openai-completions', input: ['text'], fileInputMimeTypes: [] })
    expect(resolved).toMatchObject([{ localReference: { path } }, { localReference: { path } }, { attachmentId: expect.any(String) }])
    expect(resolved.slice(0, 2).every(resource => !resource.attachmentId)).toBe(true)
    await expect(fixture.service.accept({ draftId: 'invalid', resources: [input.resources[0]!, { ...input.resources[1]!, sourcePath: join(fixture.root, 'missing') }] })).rejects.toThrow()
    expect(fixture.service.list('invalid')).toEqual([])
  })
  it.each([
    { name: 'tone.wav', mimeType: 'audio/wav', kind: 'audio', bytes: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]) },
    { name: 'tone.mp3', mimeType: 'audio/mpeg', kind: 'audio', bytes: Buffer.from('ID3\0\0\0\0\0\0\0fixture') },
    { name: 'voice.m4a', mimeType: 'audio/mp4', kind: 'audio', bytes: Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypM4A '), Buffer.alloc(8)]) },
    { name: 'clip.mp4', mimeType: 'video/mp4', kind: 'video', bytes: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisomfixture')]) },
    { name: 'clip.webm', mimeType: 'video/webm', kind: 'video', bytes: Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0]) },
  ])('keeps $name as binary media with a validated typed reference', async ({ name, mimeType, kind, bytes }) => {
    const { service, attachments } = await setup()
    expect((await service.accept({ draftId: 'media-draft', resources: [{ resourceId: 'media', name, mimeType: '', sizeBytes: bytes.length }] }))[0])
      .toMatchObject({ kind, mimeType })
    const resource = await service.complete({ draftId: 'media-draft', resourceId: 'media', bytes })
    if (resource.state !== 'ready' || !('attachmentId' in resource))
      throw new Error('Media import failed')
    const prepared = await attachments.preparePrompt([resource.attachmentId], 'Inspect this media', null, 'media-draft')
    expect(prepared.documentReferences).toEqual([{ attachmentId: resource.attachmentId, mimeType }])
    expect(await attachments.materializeDocumentInputs(prepared.documentReferences, null, 'media-draft')).toEqual([{ mimeType, name, data: bytes.toString('base64') }])
    expect(prepared.prompt).not.toContain(bytes.toString('base64'))
  })

  it('rejects mislabeled and oversized media before it can become a usable attachment', async () => {
    const { service } = await setup()
    await expect(service.accept({ draftId: 'media-draft', resources: [{ resourceId: 'large', name: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 10 * 1024 * 1024 + 1 }] }))
      .rejects
      .toThrow()
    const bytes = Buffer.from('not a media file')
    await service.accept({ draftId: 'media-draft', resources: [{ resourceId: 'invalid', name: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: bytes.length }] })
    await expect(service.complete({ draftId: 'media-draft', resourceId: 'invalid', bytes })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
    expect(service.list('media-draft')[0]).toMatchObject({ state: 'failed', errorCode: 'IMPORT_FAILED' })
  })

  it('keeps PDFs as binary snapshots with document references, not UTF-8 prompt text', async () => {
    const { service, attachments, attachmentRepository } = await setup()
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0xFF, 0xFE]), Buffer.from('\n%%EOF\n')])
    const metadata = { resourceId: 'pdf-resource', name: 'report.pdf', mimeType: '', sizeBytes: bytes.length }
    expect((await service.accept({ draftId: 'pdf-draft', resources: [metadata] }))[0]).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf' })
    const resource = await service.complete({ draftId: 'pdf-draft', resourceId: metadata.resourceId, bytes })
    if (resource.state !== 'ready' || !('attachmentId' in resource))
      throw new Error('PDF import failed')
    const record = attachmentRepository.findById(resource.attachmentId)!
    expect(await readFile(record.storedPath)).toEqual(bytes)
    const prepared = await attachments.preparePrompt([record.id], 'Read the report', null, 'pdf-draft')
    expect(prepared.imageReferences).toEqual([])
    expect(prepared.documentReferences).toEqual([{ attachmentId: record.id, mimeType: 'application/pdf' }])
    expect(prepared.prompt).toContain('report.pdf')
    expect(prepared.prompt).not.toContain('%PDF')
    expect(await attachments.materializeDocumentInputs(prepared.documentReferences, null, 'pdf-draft')).toEqual([{ name: 'report.pdf', data: bytes.toString('base64'), mimeType: 'application/pdf' }])
    await expect(attachments.materializeDocumentInputs(prepared.documentReferences, null, 'different-draft')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('keeps legacy message attachments and granted Artifacts available without creating a Space', async () => {
    const fixture = await setup()
    const workspace = join(fixture.root, 'conversation-workspace')
    await mkdir(workspace)
    fixture.conversations.create({
      approvalPolicy: 'policy',
      branchId: 'branch-1',
      createdAt: '2026-09-06T00:00:00.000Z',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: null,
      title: 'Sources without Space',
    })
    fixture.conversationGrants.grant({
      canonicalRoot: workspace,
      conversationId: 'conversation-1',
      createdAt: '2026-09-06T00:00:00.000Z',
      id: 'conversation-grant-1',
      root: workspace,
    })
    fixture.conversations.createMessage({
      branchId: 'branch-1',
      content: {
        attachmentIds: ['attachment-history'],
        text: 'legacy attachment message',
      },
      conversationId: 'conversation-1',
      createdAt: '2026-09-06T00:01:00.000Z',
      id: 'message-1',
      role: 'user',
      runId: 'run-1',
    })
    const historyPath = join(fixture.root, 'history.txt')
    await writeFile(historyPath, 'history')
    fixture.attachmentRepository.create({
      conversationId: 'conversation-1',
      createdAt: '2026-09-06T00:01:00.000Z',
      draftId: null,
      id: 'attachment-history',
      messageId: 'message-1',
      mimeType: 'text/plain',
      name: 'history.txt',
      sizeBytes: 7,
      storedPath: historyPath,
    })
    const artifactPath = join(workspace, 'artifact.txt')
    await writeFile(artifactPath, 'artifact')
    const [artifact] = await fixture.artifacts.presentOutputs({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants: [{ canonicalRoot: workspace, grantId: 'conversation-grant-1', kind: 'workspace', root: workspace }],
      paths: [artifactPath],
    })
    fixture.events.push({
      createdAt: '2026-09-06T00:02:00.000Z',
      payload: { artifactIds: [artifact!.id], sourceToolCallId: 'tool-1', sourceToolName: 'output_present' },
      runId: 'run-1',
      sequence: 1,
      type: 'output.produced',
    })

    const catalog = await fixture.service.listSources({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      draftId: 'draft-1',
      query: '',
      spaceId: null,
    })

    expect(new Set(catalog.files.map(item => item.category))).toEqual(new Set(['external', 'history', 'artifact']))
    const history = catalog.files.find(item => item.category === 'history')!
    expect(history.source).toMatchObject({
      attachmentId: 'attachment-history',
      messageId: 'message-1',
    })
    const selectedHistory = await fixture.service.selectSource({
      draftId: 'draft-1',
      resourceId: 'history-resource',
      source: history.source,
    })
    await expect(fixture.service.resolveInput(
      'draft-1',
      { ...createBuddyUserContent(), panelResourceIds: [selectedHistory.resourceId] },
      { branchId: 'branch-1', conversationId: 'conversation-1', spaceId: null },
    )).resolves.toEqual([{
      attachmentId: 'attachment-history',
      resourceId: selectedHistory.resourceId,
    }])
    expect(fixture.database.prepare('SELECT count(*) AS count FROM spaces').get()).toEqual({ count: 0 })
    fixture.conversationGrants.revokeAll('conversation-1', '2026-09-06T00:03:00.000Z')
    const afterRevocation = await fixture.service.listSources({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      draftId: 'draft-1',
      query: '',
      spaceId: null,
    })
    expect(afterRevocation.files.map(item => item.category)).toEqual(['history'])
  })

  it.each(['conversation', 'space', 'space-with-primary'])('keeps owned Artifacts and historical inputs available in %s', async (owner) => {
    const fixture = await setup()
    const spaceId = owner === 'conversation' ? null : 'space-1'
    const ownerId = spaceId ?? 'conversation-1'
    const workspace = spaceId ? fixture.paths.spaceWorkspace(spaceId) : fixture.paths.conversationWorkspace(ownerId)
    await mkdir(workspace, { recursive: true })
    const primary = join(fixture.root, 'primary')
    await mkdir(primary)
    if (spaceId) {
      fixture.spaces.create({
        id: spaceId,
        name: 'Space',
        memoryScope: 'space_only',
        createdAt: '2026-09-06T00:00:00.000Z',
        additionalDirectories: [],
        primaryDirectory: owner === 'space-with-primary' ? { id: 'binding-1', root: primary, canonicalRoot: primary, accessGrantedAt: 'now', resourcesTrustedAt: 'now' } : null,
      })
    }
    fixture.conversations.create({
      approvalPolicy: 'policy',
      branchId: 'branch-1',
      createdAt: '2026-09-06T00:00:00.000Z',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId,
      title: 'Conversation output',
    })
    const historicalPath = join(fixture.root, 'original.txt')
    await writeFile(historicalPath, 'original')
    const localReference = { kind: 'file' as const, mimeType: 'text/plain', name: 'original.txt', path: historicalPath, sizeBytes: 8 }
    fixture.conversations.createMessage({
      id: 'input-1',
      conversationId: 'conversation-1',
      branchId: 'branch-1',
      runId: 'run-1',
      role: 'user',
      createdAt: '2026-09-06T00:00:30.000Z',
      content: { userContent: { ...createBuddyUserContent(), panelResourceIds: ['local-1', 'snapshot-1'] }, resourceSnapshots: [{ resourceId: 'local-1', localReference }, { resourceId: 'snapshot-1', attachmentId: 'history-copy' }] },
    })
    fixture.attachmentRepository.create({ id: 'history-copy', conversationId: 'conversation-1', messageId: 'input-1', draftId: null, name: 'history.txt', mimeType: 'text/plain', sizeBytes: 8, storedPath: historicalPath, createdAt: '2026-09-06T00:00:30.000Z' })
    fixture.conversations.createMessage({
      branchId: 'branch-1',
      content: { text: 'generated output' },
      conversationId: 'conversation-1',
      createdAt: '2026-09-06T00:01:00.000Z',
      id: 'message-1',
      role: 'assistant',
      runId: 'run-1',
    })
    const artifactPath = join(workspace, 'artifact.txt')
    await writeFile(artifactPath, 'artifact')
    const [artifact] = await fixture.artifacts.presentOutputs({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants: [{ canonicalRoot: workspace, grantId: ownerId, kind: 'workspace', root: workspace }],
      paths: [artifactPath],
    })
    fixture.events.push({
      createdAt: '2026-09-06T00:02:00.000Z',
      payload: { artifactIds: [artifact!.id], sourceToolCallId: 'tool-1', sourceToolName: 'output_present' },
      runId: 'run-1',
      sequence: 1,
      type: 'output.produced',
    })

    const catalog = await fixture.service.listSources({
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      draftId: 'draft-1',
      query: '',
      spaceId,
    })

    expect(catalog.files.filter(item => item.category === 'history').map(item => item.label)).toEqual(['original.txt', 'history.txt'])
    const historical = await fixture.service.selectSource({ draftId: 'draft-1', resourceId: 'historical-local', source: catalog.files.find(item => item.label === 'original.txt')!.source })
    await rm(historicalPath)
    expect(await fixture.service.resolveInput('draft-1', { ...createBuddyUserContent(), panelResourceIds: [historical.resourceId] }, { branchId: 'branch-1', conversationId: 'conversation-1', spaceId })).toEqual([{ resourceId: 'historical-local', localReference }])
    const artifactOption = catalog.files.find(item => item.category === 'artifact')
    expect(artifactOption).toMatchObject({
      label: 'artifact.txt',
      source: { artifactId: artifact!.id, conversationId: 'conversation-1' },
    })
    const selected = await fixture.service.selectSource({
      draftId: 'draft-1',
      resourceId: 'artifact-resource',
      source: artifactOption!.source,
    })
    const input = await fixture.service.resolveInput(
      'draft-1',
      { ...createBuddyUserContent(), panelResourceIds: [selected.resourceId] },
      { branchId: 'branch-1', conversationId: 'conversation-1', spaceId },
    )
    expect(input).toEqual([{ resourceId: selected.resourceId, localReference: { kind: 'file', mimeType: 'text/plain', name: 'artifact.txt', path: artifactPath, sizeBytes: 8 } }])
    expect(fixture.attachmentRepository.listDraftsBefore('9999')).toEqual([])
    const foreignRoot = join(fixture.root, 'foreign-workspace')
    await mkdir(foreignRoot)
    const foreignPath = join(foreignRoot, 'foreign.txt')
    await writeFile(foreignPath, 'foreign')
    const [foreign] = await fixture.artifacts.presentOutputs({ conversationId: 'conversation-1', cwd: foreignRoot, grants: [{ canonicalRoot: foreignRoot, grantId: ownerId, kind: 'workspace', root: foreignRoot }], paths: [foreignPath] })
    fixture.events[0]!.payload = { artifactIds: [artifact!.id, foreign!.id], sourceToolCallId: 'tool-1', sourceToolName: 'output_present' }
    const updated = await fixture.service.listSources({ branchId: 'branch-1', conversationId: 'conversation-1', spaceId, draftId: 'draft-1', query: '' })
    expect(updated.files.filter(item => item.category === 'artifact').map(item => item.label)).toEqual(['artifact.txt'])
    await expect(fixture.service.selectSource({ draftId: 'draft-1', resourceId: 'foreign', source: { artifactId: foreign!.id, conversationId: 'conversation-1', branchId: 'branch-1' } })).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
  })

  it('lists visible lineage sources, reuses historical bytes, and references the current text Artifact', async () => {
    const fixture = await setup()
    const workspace = join(fixture.root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'space.txt'), 'space')
    fixture.spaces.create({
      id: 'space-1',
      name: 'Workspace',
      memoryScope: 'personal_and_space',
      createdAt: '2026-09-06T00:00:00.000Z',
      additionalDirectories: [],
      primaryDirectory: { id: 'binding-1', root: workspace, canonicalRoot: workspace, accessGrantedAt: 'now', resourcesTrustedAt: 'now' },
    })
    fixture.conversations.create({
      approvalPolicy: 'policy',
      branchId: 'branch-1',
      createdAt: '2026-09-06T00:00:00.000Z',
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      spaceId: 'space-1',
      title: 'Sources',
    })
    const messageContent = {
      resourceSnapshots: [{ attachmentId: 'attachment-history', resourceId: 'history-snapshot' }],
      userContent: { ...createBuddyUserContent(), panelResourceIds: ['history-snapshot'] },
    }
    fixture.conversations.createMessage({
      branchId: 'branch-1',
      content: messageContent,
      conversationId: 'conversation-1',
      createdAt: '2026-09-06T00:01:00.000Z',
      id: 'message-1',
      role: 'user',
      runId: 'run-1',
    })
    const historyPath = join(fixture.root, 'history.txt')
    await writeFile(historyPath, 'immutable')
    fixture.attachmentRepository.create({
      conversationId: 'conversation-1',
      createdAt: '2026-09-06T00:01:00.000Z',
      draftId: null,
      id: 'attachment-history',
      messageId: 'message-1',
      mimeType: 'text/plain',
      name: 'history.txt',
      sizeBytes: 9,
      storedPath: historyPath,
    })
    const artifactPath = join(workspace, 'artifact.txt')
    await writeFile(artifactPath, 'before')
    const [artifact] = await fixture.artifacts.presentOutputs({
      conversationId: 'conversation-1',
      cwd: workspace,
      grants: [{ canonicalRoot: workspace, grantId: 'binding-1', kind: 'workspace', root: workspace }],
      paths: [artifactPath],
    })
    fixture.events.push({
      createdAt: '2026-09-06T00:02:00.000Z',
      payload: { artifactIds: [artifact!.id], sourceToolCallId: 'tool-1', sourceToolName: 'output_present' },
      runId: 'run-1',
      sequence: 1,
      type: 'output.produced',
    })
    const scope = { branchId: 'branch-1', conversationId: 'conversation-1', spaceId: 'space-1' }
    const catalog = await fixture.service.listSources({ ...scope, draftId: 'draft-1', query: '' })
    expect(new Set(catalog.files.map(item => item.category))).toEqual(new Set(['space', 'history', 'artifact']))

    const history = catalog.files.find(item => item.category === 'history')!
    const firstHistory = await fixture.service.selectSource({ draftId: 'draft-1', resourceId: 'history-1', source: history.source })
    expect(await fixture.service.selectSource({ draftId: 'draft-1', resourceId: 'history-2', source: history.source })).toEqual(firstHistory)
    const historyInput = await fixture.service.resolveInput('draft-1', { ...createBuddyUserContent(), panelResourceIds: [firstHistory.resourceId] }, scope)
    expect(historyInput).toEqual([{ attachmentId: 'attachment-history', resourceId: firstHistory.resourceId }])

    const artifactOption = catalog.files.find(item => item.category === 'artifact')!
    const artifactResource = await fixture.service.selectSource({ draftId: 'draft-1', resourceId: 'artifact-1', source: artifactOption.source })
    await writeFile(artifactPath, 'at send')
    const artifactInput = await fixture.service.resolveInput('draft-1', { ...createBuddyUserContent(), panelResourceIds: [artifactResource.resourceId] }, scope)
    expect(artifactInput).toEqual([{ resourceId: artifactResource.resourceId, localReference: { kind: 'file', mimeType: 'text/plain', name: 'artifact.txt', path: artifactPath, sizeBytes: 7 } }])
    await writeFile(artifactPath, 'later')
    expect(artifactInput[0]!.localReference!.sizeBytes).toBe(7)
    expect(fixture.attachmentRepository.listDraftsBefore('9999')).toEqual([])
    await expect(fixture.service.selectSource({
      draftId: 'draft-1',
      resourceId: 'hidden',
      source: { ...history.source, branchId: 'hidden-branch' },
    })).rejects.toBeInstanceOf(Error)
  })

  it('keeps Space text references live, preserves metadata at send, and migrates legacy draft tokens', async () => {
    const { service, root, spaces, attachmentRepository, database, drafts } = await setup()
    const directory = join(root, 'workspace')
    await mkdir(directory)
    await writeFile(join(directory, 'note.txt'), 'before')
    spaces.create({
      id: 'space-1',
      name: 'Workspace',
      memoryScope: 'personal_and_space',
      createdAt: new Date().toISOString(),
      additionalDirectories: [],
      primaryDirectory: { id: 'binding-1', root: directory, canonicalRoot: directory, accessGrantedAt: 'now', resourcesTrustedAt: 'now' },
    })
    const input = { draftId: 'draft-1', resourceId: 'resource-1', source: { spaceId: 'space-1', bindingId: 'binding-1', relativePath: 'note.txt' } }
    const selected = await service.selectSpaceFile(input)
    expect(selected).toMatchObject({ resourceId: 'resource-1', state: 'ready', sourcePath: join(directory, 'note.txt'), source: { origin: { ...input.source, bindingRevision: 1 } } })
    expect(await service.selectSpaceFile(input)).toEqual(selected)
    expect(await service.selectSpaceFile({ ...input, resourceId: 'resource-duplicate' })).toEqual(selected)
    expect(database.prepare('SELECT count(*) AS count FROM attachments').get()).toEqual({ count: 0 })
    const content = { ...createBuddyUserContent(), panelResourceIds: ['resource-1'] }
    drafts.open({
      draftId: 'draft-1',
      initialContent: content,
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: null,
      now: new Date().toISOString(),
      scope: { kind: 'global' },
    })
    await service.cleanupDrafts(new Date('2099-01-01').getTime())
    expect(service.list('draft-1')).toContainEqual(selected)
    await writeFile(join(directory, 'note.txt'), 'at send')
    const frozen = await service.resolveInput('draft-1', content, { branchId: null, conversationId: null, spaceId: 'space-1' })
    expect(frozen[0]).toEqual({ resourceId: 'resource-1', localReference: { kind: 'file', mimeType: 'text/plain', name: 'note.txt', path: join(directory, 'note.txt'), sizeBytes: 7 } })
    expect(attachmentRepository.listDraftsBefore('9999')).toEqual([])
    await writeFile(join(directory, 'note.txt'), 'later')
    expect(frozen[0]!.localReference!.sizeBytes).toBe(7)
    expect((await service.resolveInput('draft-1', content, { branchId: null, conversationId: null, spaceId: 'space-1' }))[0]!.localReference!.sizeBytes).toBe(5)
    await expect(service.resolveInput('draft-1', content)).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
    const legacy = { drafts: [{ draftId: 'draft-1', targetKey: 'space:space-1', content: '$writer @note.txt', composerContent: { type: 'doc', attrs: { panelResourceIds: [] }, content: [{ type: 'paragraph', content: [
      { type: 'chatPromptToken', attrs: { kind: 'skill', value: 'writer' } },
      { type: 'text', text: ' ' },
      { type: 'chatPromptToken', attrs: { kind: 'file', value: join(directory, 'note.txt') } },
      { type: 'chatResourceReference', attrs: { resourceId: 'resource-1' } },
    ] }] } }] }
    const normalized = await normalizeComposerWorkspace(legacy, { resources: service, conversations: createConversationRepository(database) })
    expect(normalized).toMatchObject({ drafts: [{ composerContent: { content: [{ content: [
      { type: 'chatPromptDirective', attrs: { directive: 'skill', value: 'writer' } },
      { type: 'text', text: ' ' },
      { type: 'chatResourceReference', attrs: { resourceId: 'resource-1' } },
      { type: 'chatResourceReference', attrs: { resourceId: 'resource-1' } },
    ] }] } }] })
    expect(legacy.drafts[0]!.composerContent.content[0]!.content[0]!.type).toBe('chatPromptToken')
    await writeFile(join(directory, '.env'), 'synthetic=value')
    await expect(service.selectSpaceFile({ ...input, resourceId: 'sensitive', source: { ...input.source, relativePath: '.env' } })).rejects.toMatchObject({ code: 'DIRECTORY_NOT_AUTHORIZED' })
    await writeFile(join(directory, 'note.txt'), Uint8Array.of(255))
    await expect(service.resolveInput('draft-1', content, { branchId: null, conversationId: null, spaceId: 'space-1' })).resolves.toMatchObject([{ localReference: { sizeBytes: 1 } }])
    await rm(join(directory, 'note.txt'))
    await writeFile(join(root, 'outside.txt'), 'outside')
    await symlink(join(root, 'outside.txt'), join(directory, 'note.txt'))
    await expect(service.resolveInput('draft-1', content, { branchId: null, conversationId: null, spaceId: 'space-1' })).rejects.toBeInstanceOf(Error)
  })

  it('sends a panel-only resource through the real turn transaction and replays the immutable input', async () => {
    const { service, attachments, database, attachmentRepository } = await setup()
    const conversations = createConversationRepository(database)
    const drafts = createComposerDraftRepository(database)
    const runs = createRunRepository(database)
    const runInputs = createRunInputRepository(database)
    let failNextLaunch = false
    const turns = new ChatTurnService({
      inputValidation: { validate: async () => {} },
      attachments,
      composerResources: service,
      conversations,
      drafts,
      runs,
      runInputs,
      turnRequests: createTurnRequestRepository(database),
      spaces: createSpaceRepository(database),
      conversationLifecycle: { isDeleting: () => false },
      skills: { materializeForSpace: async () => [{ reference: { id: 'writer-id', name: 'writer', revision: 'writer-revision' }, name: 'writer', body: 'Use concise wording.', filePath: '/fixture/skills/writer/SKILL.md', baseDirectory: '/fixture/skills/writer' }] },
      runner: { cancel: async () => false },
      providers: {
        getDefaultModel: async () => ({ modelId: 'offline', providerId: 'fixture', reasoning: null, serviceTier: null }),
        executionModels: { getServiceTiers: () => [], resolveAvailable: async () => ({
          api: 'openai-completions',
          id: 'offline',
          name: 'Offline',
          provider: 'fixture',
          baseUrl: 'http://127.0.0.1:9',
          reasoning: false,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        }) },
      },
      turnLauncher: {
        launch: async (runId) => {
          if (failNextLaunch) {
            failNextLaunch = false
            runs.reconcileTerminal(runId, 'failed', new Date().toISOString(), 'AGENT_RUN_FAILED')
          }
          return { runId, completion: Promise.resolve(runs.findById(runId)!) }
        },
      },
    })
    const userContent = { ...createBuddyUserContent(), panelResourceIds: ['resource-1'] }
    const draft = drafts.open({
      draftId: 'draft-1',
      initialContent: userContent,
      initialExecutionConfig: {
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
      },
      initialModelSelection: null,
      now: '2026-09-06T00:00:00.000Z',
      scope: { kind: 'global' },
    })
    await service.accept({ draftId: 'draft-1', resources: [{ resourceId: 'resource-1', mimeType: 'text/plain', name: 'note.txt', sizeBytes: 3, sourcePath: '/fixture/note.txt' }] })
    const request = {
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      requestId: 'request-1',
    }
    await expect(turns.start(request)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 })
    const ready = await service.complete({ draftId: 'draft-1', resourceId: 'resource-1', bytes: new TextEncoder().encode('abc') })
    database.exec(`
      CREATE TRIGGER fail_precommit_run
      BEFORE INSERT ON runs
      BEGIN
        SELECT RAISE(ABORT, 'injected precommit failure');
      END;
    `)
    await expect(turns.start({ ...request, requestId: 'precommit-failure' })).rejects.toThrow(
      'injected precommit failure',
    )
    database.exec('DROP TRIGGER fail_precommit_run')
    expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 0 })
    expect(drafts.findById(draft.draftId)).toEqual(draft)
    expect(attachmentRepository.listAll()).toHaveLength(1)
    expect(await attachments.reconcileStorage()).toMatchObject({ removedOrphanFiles: 0 })
    const turn = await turns.start(request)
    expect(await turns.start(request)).toEqual(turn)
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 })
    const message = conversations.listBranchMessages(turn.conversationId, turn.branchId)[0]!
    expect(message.content).toMatchObject({
      userContent,
      resourceSnapshots: [{ resourceId: 'resource-1', attachmentId: expect.any(String) }],
    })
    const stored = runInputs.findByRunId(turn.runId)!
    expect(stored.prompt).toBe('[FILE#1]\n\n[FILE#1] "note.txt" (TEXT)\nabc')
    expect(stored.attachmentIds).toHaveLength(1)
    const snapshot = attachmentRepository.findById(stored.attachmentIds[0]!)!
    expect(snapshot.sourcePath).toBe('/fixture/note.txt')
    expect(snapshot.messageId).toBe(message.id)
    expect(await readFile(snapshot.storedPath, 'utf8')).toBe('abc')
    expect(service.list('draft-1')).toEqual([ready])

    runs.reconcileTerminal(turn.runId, 'failed', new Date().toISOString(), 'RUNTIME_RESTARTED')
    const interrupted = await turns.start(request)
    expect(interrupted.runId).toBe(turn.runId)
    expect(interrupted.run.status).toBe('failed')
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 1 })

    const originalMessage = conversations.listBranchMessages(turn.conversationId, turn.branchId)[0]!
    const editDraft = drafts.open({
      draftId: 'message-edit-draft',
      initialContent: createBuddyUserContent(),
      initialExecutionConfig: {
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
      },
      initialModelSelection: null,
      now: '2026-09-06T00:00:00.500Z',
      scope: {
        branchId: turn.branchId,
        conversationId: turn.conversationId,
        kind: 'message_edit',
        userMessageId: originalMessage.id,
      },
    })
    const editedResource = await service.selectSource({
      draftId: editDraft.draftId,
      resourceId: 'edited-resource',
      source: {
        attachmentId: snapshot.id,
        branchId: turn.branchId,
        conversationId: turn.conversationId,
        messageId: originalMessage.id,
      },
    })
    const editedContent = {
      ...createBuddyUserContent(),
      body: [{
        type: 'paragraph' as const,
        content: [
          { type: 'prompt_directive' as const, directive: 'slash_command' as const, commandMode: 'prompt' as const, value: '/plan' },
          { type: 'text' as const, text: ' revise with the snapshot' },
        ],
      }],
      panelResourceIds: [editedResource.resourceId],
    }
    const savedEditDraft = drafts.save({
      content: editedContent,
      draftId: editDraft.draftId,
      executionConfig: editDraft.executionConfig,
      expectedRevision: editDraft.revision,
      modelSelection: editDraft.modelSelection,
      now: '2026-09-06T00:00:00.600Z',
    })
    const editedTurn = await turns.editUserMessage({
      conversationId: turn.conversationId,
      draftId: savedEditDraft.draftId,
      expectedRevision: savedEditDraft.revision,
      requestId: 'edit-message-1',
      userMessageId: originalMessage.id,
    })
    expect(editedTurn.draftReceipt).toEqual({
      committedRevision: savedEditDraft.revision + 1,
      draftId: savedEditDraft.draftId,
      sourceRevision: savedEditDraft.revision,
    })
    const originalAfterEdit = conversations.listBranchMessages(turn.conversationId, turn.branchId)[0]!
    expect(originalAfterEdit.id).toBe(originalMessage.id)
    expect(originalAfterEdit.content).toEqual(originalMessage.content)
    const editedBranchMessage = conversations.listBranchMessages(turn.conversationId, editedTurn.branchId)[0]!
    expect(editedBranchMessage.id).not.toBe(originalMessage.id)
    expect(editedBranchMessage.content).toMatchObject({
      resourceSnapshots: [{ resourceId: 'edited-resource', attachmentId: expect.any(String) }],
      userContent: editedContent,
    })
    const editedAttachmentId = (editedBranchMessage.content as { resourceSnapshots: Array<{ attachmentId: string }> }).resourceSnapshots[0]!.attachmentId
    expect(attachmentRepository.findById(editedAttachmentId)?.sourcePath).toBe('/fixture/note.txt')
    expect(editedAttachmentId).not.toBe((originalMessage.content as { resourceSnapshots: Array<{ attachmentId: string }> }).resourceSnapshots[0]!.attachmentId)
    expect(await readFile(attachmentRepository.findById(editedAttachmentId)!.storedPath, 'utf8')).toBe('abc')
    expect(runInputs.findByRunId(editedTurn.runId)!.prompt).toContain('/plan revise with the snapshot')

    const mixedContent = { ...createBuddyUserContent(), body: [{ type: 'paragraph' as const, content: [
      { type: 'prompt_directive' as const, directive: 'slash_command' as const, commandMode: 'prompt' as const, value: '/plan' },
      { type: 'text' as const, text: ' Use ' },
      { type: 'prompt_directive' as const, directive: 'skill' as const, value: 'writer' },
    ] }] }
    const mixedDraft = drafts.open({
      draftId: 'draft-2',
      initialContent: mixedContent,
      initialExecutionConfig: {
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
      },
      initialModelSelection: null,
      now: '2026-09-06T00:00:01.000Z',
      scope: { kind: 'global' },
    })
    const mixed = await turns.start({
      draftId: mixedDraft.draftId,
      expectedRevision: mixedDraft.revision,
      requestId: 'mixed',
    })
    expect(runInputs.findByRunId(mixed.runId)!.prompt).toContain('/plan Use ')
    expect(runInputs.findByRunId(mixed.runId)!.prompt).toContain('Use concise wording.')
    expect(conversations.listBranchMessages(mixed.conversationId, mixed.branchId)[0]!.content).toMatchObject({
      resourceSnapshots: [],
      userContent: mixedContent,
    })
    const runsBefore = database.prepare('SELECT count(*) AS count FROM runs').get()
    const badDraft = drafts.open({
      draftId: 'draft-bad-command',
      initialContent: { ...createBuddyUserContent(), body: [{ type: 'paragraph', content: [{ type: 'prompt_directive', directive: 'slash_command', commandMode: 'prompt', value: '/compact' }] }] },
      initialExecutionConfig: {
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
      },
      initialModelSelection: null,
      now: '2026-09-06T00:00:02.000Z',
      scope: { kind: 'global' },
    })
    await expect(turns.start({
      draftId: badDraft.draftId,
      expectedRevision: badDraft.revision,
      requestId: 'bad-command',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual(runsBefore)

    const postCommitContent = {
      ...createBuddyUserContent(),
      body: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'post-commit launch' }] }],
    }
    const postCommitDraft = drafts.save({
      content: postCommitContent,
      draftId: badDraft.draftId,
      executionConfig: badDraft.executionConfig,
      expectedRevision: badDraft.revision,
      modelSelection: badDraft.modelSelection,
      now: '2026-09-06T00:00:03.000Z',
    })
    failNextLaunch = true
    const failedTurn = await turns.start({
      draftId: postCommitDraft.draftId,
      expectedRevision: postCommitDraft.revision,
      requestId: 'postcommit-failure',
    })
    expect(failedTurn.run).toMatchObject({ errorCode: 'AGENT_RUN_FAILED', status: 'failed' })
    expect(drafts.findById(postCommitDraft.draftId)).toMatchObject({
      content: createBuddyUserContent(),
      revision: postCommitDraft.revision + 1,
      scope: {
        branchId: failedTurn.branchId,
        conversationId: failedTurn.conversationId,
        kind: 'conversation_branch',
      },
    })
    const messageCount = database.prepare('SELECT count(*) AS count FROM messages').get()
    const retriedTurn = await turns.regenerateAssistant({
      conversationId: failedTurn.conversationId,
      requestId: 'retry-postcommit-failure',
      sourceRunId: failedTurn.runId,
    })
    expect(retriedTurn.runId).not.toBe(failedTurn.runId)
    expect(retriedTurn.branchId).not.toBe(failedTurn.branchId)
    expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual(messageCount)
  })

  it('retains the image snapshot when sending to a text-only model', async () => {
    const { service, attachments, database } = await setup()
    const drafts = createComposerDraftRepository(database)
    const runs = createRunRepository(database)
    const imageDraft = drafts.open({
      draftId: 'draft-image',
      initialContent: { ...createBuddyUserContent(), panelResourceIds: ['image-resource'] },
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: null,
      now: '2026-09-06T00:00:00.000Z',
      scope: { kind: 'global' },
    })
    const png = imageBytes()
    await service.accept({ draftId: imageDraft.draftId, resources: [{ resourceId: 'image-resource', mimeType: 'image/png', name: 'image.png', sizeBytes: png.length }] })
    await service.complete({ draftId: imageDraft.draftId, resourceId: 'image-resource', bytes: png })
    const turns = new ChatTurnService({
      inputValidation: { validate: async () => {} },
      attachments,
      composerResources: service,
      conversations: createConversationRepository(database),
      conversationLifecycle: { isDeleting: () => false },
      drafts,
      providers: {
        getDefaultModel: async () => ({ modelId: 'text-only', providerId: 'fixture', reasoning: null, serviceTier: null }),
        executionModels: { getServiceTiers: () => [], resolveAvailable: async () => ({
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:9',
          contextWindow: 128000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          id: 'text-only',
          input: ['text'],
          maxTokens: 4096,
          name: 'Text only',
          provider: 'fixture',
          reasoning: false,
        }) },
      },
      runner: { cancel: async () => false },
      runInputs: createRunInputRepository(database),
      runs,
      skills: { materializeForSpace: async () => [] },
      spaces: createSpaceRepository(database),
      turnLauncher: { launch: async runId => ({ runId, completion: Promise.resolve(runs.findById(runId)!) }) },
      turnRequests: createTurnRequestRepository(database),
    })
    await expect(turns.start({
      draftId: imageDraft.draftId,
      expectedRevision: imageDraft.revision,
      requestId: 'image-unsupported',
    })).resolves.toMatchObject({ run: { modelId: 'text-only' } })
    expect(database.prepare('SELECT count(*) AS count FROM runs').get()).toEqual({ count: 1 })
  })

  it('accepts metadata before bytes, binds a distinct immutable file identity, and replays completion', async () => {
    const { service, paths, attachmentRepository } = await setup()
    const bytes = imageBytes()
    const input = { draftId: 'draft-1', resources: [{ resourceId: 'resource-1', mimeType: 'image/png', name: 'two-pixels.png', sizeBytes: bytes.length }] }
    expect(await service.accept(input)).toEqual([{ ...input.resources[0], nameSource: 'file', draftId: 'draft-1', kind: 'image', state: 'importing' }])
    await expect(readdir(paths.draftAttachments('draft-1'))).rejects.toMatchObject({ code: 'ENOENT' })
    const ready = await service.complete({ draftId: 'draft-1', resourceId: 'resource-1', bytes })
    expect(ready.state).toBe('ready')
    if (ready.state !== 'ready' || !('attachmentId' in ready))
      throw new Error('Expected ready resource')
    expect(ready.attachmentId).not.toBe(ready.resourceId)
    expect(await readFile(attachmentRepository.findById(ready.attachmentId)!.storedPath)).toEqual(Buffer.from(bytes))
    expect(await service.complete({ draftId: 'draft-1', resourceId: 'resource-1', bytes })).toEqual(ready)
    expect(await readdir(paths.draftAttachments('draft-1'))).toHaveLength(1)
    expect(await service.accept(input)).toEqual([ready])
    await expect(service.complete({ draftId: 'draft-1', resourceId: 'resource-1', bytes: Uint8Array.of(1) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(service.list('draft-1')).toEqual([ready])
  })

  it('rejects a whole invalid or conflicting metadata batch without partially accepting it', async () => {
    const { service } = await setup()
    const text = { resourceId: 'existing', mimeType: 'text/plain', name: 'note.txt', sizeBytes: 1 }
    await service.accept({ draftId: 'draft-1', resources: [text] })
    await expect(service.accept({ draftId: 'draft-1', resources: [{ ...text, resourceId: 'new' }, { ...text, name: 'changed.txt' }] })).rejects.toThrow()
    expect(service.list('draft-1').map(resource => resource.resourceId)).toEqual(['existing'])
    await expect(service.accept({ draftId: 'draft-1', resources: [{ ...text, resourceId: 'new' }, { ...text, resourceId: 'bad', name: 'bad.zip', mimeType: 'application/zip' }] })).rejects.toThrow()
    expect(service.list('draft-1')).toHaveLength(1)
  })

  it.each([
    ['application/pdf', 'bad.pdf', Uint8Array.of(1, 2), 2],
    ['image/png', 'bad.png', Uint8Array.of(1, 2), 2],
    ['text/plain', 'bad.txt', Uint8Array.of(255, 254), 2],
    ['text/plain', 'short.txt', Uint8Array.of(65), 2],
  ])('keeps invalid %s input failed, without publishing a file', async (mimeType, name, bytes, sizeBytes) => {
    const { service, attachmentRepository } = await setup()
    await service.accept({ draftId: 'draft-1', resources: [{ resourceId: 'resource-1', mimeType, name, sizeBytes }] })
    await expect(service.complete({ draftId: 'draft-1', resourceId: 'resource-1', bytes })).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
    const failed = service.list('draft-1')[0]
    expect(failed).toMatchObject({ resourceId: 'resource-1', state: 'failed', errorCode: 'IMPORT_FAILED' })
    expect(attachmentRepository.listDraftsBefore('9999')).toHaveLength(0)
  })

  it('retries the same resource identity and does not allow cross-draft completion', async () => {
    const { service } = await setup()
    await service.accept({ draftId: 'draft-1', resources: [{ resourceId: 'resource-1', mimeType: 'text/plain', name: 'note.txt', sizeBytes: 2 }] })
    const target = { draftId: 'draft-1', resourceId: 'resource-1' }
    await expect(service.complete({ ...target, draftId: 'draft-2', bytes: Uint8Array.of(65, 66) })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    service.fail(target)
    expect(service.retry(target)).toMatchObject({ ...target, state: 'importing' })
    expect(await service.complete({ ...target, bytes: Uint8Array.of(65, 66) })).toMatchObject({ ...target, state: 'ready' })
    service.recoverInterruptedImports()
    expect(service.list('draft-1')[0]!.state).toBe('ready')
  })

  it('recovers interrupted imports as failed and keeps confirmed draft resources out of cleanup', async () => {
    const { service, drafts } = await setup()
    await service.accept({ draftId: 'draft-1', resources: [1, 2].map(id => ({ resourceId: `resource-${id}`, mimeType: 'text/plain', name: `${id}.txt`, sizeBytes: 1 })) })
    const ready = await service.complete({ draftId: 'draft-1', resourceId: 'resource-1', bytes: Uint8Array.of(65) })
    drafts.open({
      draftId: 'draft-1',
      initialContent: { ...createBuddyUserContent(), panelResourceIds: ['resource-1'] },
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: null,
      now: new Date().toISOString(),
      scope: { kind: 'global' },
    })
    service.recoverInterruptedImports()
    expect(service.list('draft-1')).toEqual([ready, expect.objectContaining({ resourceId: 'resource-2', state: 'failed', errorCode: 'IMPORT_INTERRUPTED' })])
    await service.cleanupDrafts(new Date('2099-01-01').getTime())
    expect(service.list('draft-1')[0]).toEqual(ready)
  })

  it('reclaims an unreferenced draft resource and its managed bytes after retention', async () => {
    const { service, drafts, attachmentRepository } = await setup()
    await service.accept({ draftId: 'draft-1', resources: [{ resourceId: 'resource-1', mimeType: 'text/plain', name: '1.txt', sizeBytes: 1 }] })
    const ready = await service.complete({ draftId: 'draft-1', resourceId: 'resource-1', bytes: Uint8Array.of(65) })
    if (ready.state !== 'ready' || !('attachmentId' in ready))
      throw new Error('Expected ready resource')
    drafts.open({
      draftId: 'draft-1',
      initialContent: createBuddyUserContent(),
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      initialModelSelection: null,
      now: new Date().toISOString(),
      scope: { kind: 'global' },
    })

    await expect(service.cleanupDrafts(new Date('2099-01-01').getTime())).resolves.toEqual([ready.attachmentId])
    expect(service.list('draft-1')).toEqual([])
    expect(attachmentRepository.findById(ready.attachmentId)).toBeNull()
  })

  it('rejects native files beyond the current resource capacity before copying them', async () => {
    const { service, attachmentRepository, root } = await setup()
    const sourcePath = join(root, 'note.txt')
    await writeFile(sourcePath, 'note')
    const resources = Array.from({ length: BUDDY_ATTACHMENT_COUNT_LIMIT }, (_, index) => ({
      mimeType: 'text/plain',
      name: `${index}.txt`,
      resourceId: `resource-${index}`,
      sizeBytes: 1,
    }))
    await service.accept({ draftId: 'draft-1', resources })

    await expect(service.registerFiles({
      draftId: 'draft-1',
      paths: [sourcePath],
      referencedResourceIds: resources.map(resource => resource.resourceId),
    })).rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT_EXCEEDED' })
    expect(attachmentRepository.listDraftsBefore('9999')).toEqual([])
  })

  it('restores a ready resource with unavailable storage as a removable failure', async () => {
    const { service } = await setup()
    await service.accept({ draftId: 'draft-1', resources: [{ resourceId: 'resource-1', mimeType: 'text/plain', name: '1.txt', sizeBytes: 1 }] })
    const ready = await service.complete({ draftId: 'draft-1', resourceId: 'resource-1', bytes: Uint8Array.of(65) })
    if (ready.state !== 'ready' || !('attachmentId' in ready))
      throw new Error('Expected ready resource')

    service.recoverInterruptedImports([ready.attachmentId])

    expect(service.list('draft-1')).toEqual([
      expect.objectContaining({
        errorCode: 'IMPORT_INTERRUPTED',
        resourceId: 'resource-1',
        state: 'failed',
      }),
    ])
    expect('attachmentId' in service.list('draft-1')[0]!).toBe(false)
  })

  it('projects two images with repeat references and a panel-only text file exactly once', async () => {
    const { service, attachments } = await setup()
    const bytes = imageBytes()
    for (const id of ['red', 'blue']) {
      await service.accept({ draftId: 'draft-1', resources: [{ resourceId: id, mimeType: 'image/png', name: `${id}.png`, sizeBytes: bytes.length }] })
      await service.complete({ draftId: 'draft-1', resourceId: id, bytes })
    }
    await service.accept({ draftId: 'draft-1', resources: [{ resourceId: 'note', mimeType: 'text/plain', name: 'note.txt', sizeBytes: 3 }] })
    await service.complete({ draftId: 'draft-1', resourceId: 'note', bytes: new TextEncoder().encode('abc') })
    const content = { ...createBuddyUserContent(), panelResourceIds: ['red', 'blue', 'note'], body: [{ type: 'paragraph' as const, content: [
      { type: 'resource_ref' as const, resourceId: 'red' },
      { type: 'text' as const, text: ' vs ' },
      { type: 'resource_ref' as const, resourceId: 'blue' },
      { type: 'resource_ref' as const, resourceId: 'red' },
    ] }] }
    const bindings = await service.resolveInput('draft-1', content)
    const result = await attachments.materializePrompt(bindings.flatMap(binding => binding.attachmentId ? [binding.attachmentId] : []), '', null, 'draft-1', { content, resourceIds: bindings.map(binding => binding.resourceId) })
    expect(result.prompt).toBe('[FILE#1]\n\n[FILE#2] vs [FILE#3][FILE#2]\n\n[FILE#1] "note.txt" (TEXT)\nabc\n\n[FILE#2] "red.png" (IMAGE)\n\n[FILE#3] "blue.png" (IMAGE)')
    expect(result.images).toHaveLength(2)
    expect(result.records).toHaveLength(3)
  })
})
