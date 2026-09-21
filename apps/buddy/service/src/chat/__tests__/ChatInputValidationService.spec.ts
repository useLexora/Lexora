import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { InputModel } from '../../providers/modelCapabilities'
import type { AttachmentRecord } from '../../storage/attachmentRepository'
import type { ChatInputValidationInput } from '../ChatInputValidationService'
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { createBuddyInputReference, createBuddyInputReferenceMessage } from '../../agent/context/BuddyInputReference'
import { createReusableBuddySession } from '../../agent/sessions/createReusableBuddySession'
import { ChatInputValidationService } from '../ChatInputValidationService'

describe('chat input validation', () => {
  it('allows native bytes to be projected at request time', async () => {
    const fixture = createFixture()
    const audio = fixture.attach('audio/wav', 8 * 1024 * 1024)
    await expect(fixture.service.validate({ ...input(), attachments: [audio] })).resolves.toBeUndefined()
    fixture.history.appendMessage(reference(audio))
    await expect(fixture.service.validate({ ...input(), attachments: [audio] })).resolves.toBeUndefined()
    await expect(fixture.service.validate(input())).resolves.toBeUndefined()
  })

  it('still rejects oversized mandatory text', async () => {
    const fixture = createFixture()
    fixture.history.appendMessage(reference(fixture.attach('image/png', 7 * 1024 * 1024)))
    await expect(fixture.service.validate({ ...input(), prompt: 'x'.repeat(20 * 1024 * 1024), attachments: [fixture.attach('application/pdf', 5 * 1024 * 1024)] })).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' })
  })

  it('uses the compacted branch context instead of all historical attachment records', async () => {
    const fixture = createFixture()
    fixture.history.appendMessage(reference(fixture.attach('audio/wav', 8 * 1024 * 1024)))
    const kept = fixture.history.appendMessage({ role: 'user', content: 'Continue', timestamp: 1 })
    fixture.history.appendCompaction('Earlier audio was summarized.', kept, 100_000)
    await expect(fixture.service.validate({ ...input(), attachments: [fixture.attach('audio/wav', 8 * 1024 * 1024)] })).resolves.toBeUndefined()
  })

  it.each(['google-generative-ai', 'openai-completions'] as const)('allows file-only M4A on %s alongside native audio', async (api) => {
    const fixture = createFixture({ api })
    await expect(fixture.service.validate({ ...input(), attachments: [fixture.attach('audio/mp4', 100)] })).resolves.toBeUndefined()
    await expect(fixture.service.validate({ ...input(), attachments: [fixture.attach('audio/mpeg', 100)] })).resolves.toBeUndefined()
  })

  it('accepts M4A only for the adapter that supports its data URL format', async () => {
    const fixture = createFixture({ api: 'openai-completions', baseUrl: 'https://api.xiaomimimo.com/v1' })
    await expect(fixture.service.validate({ ...input(), attachments: [fixture.attach('audio/mp4', 100)] })).resolves.toBeUndefined()
  })

  it('validates historical formats when switching models', async () => {
    const fixture = createFixture({ api: 'openai-completions' })
    fixture.history.appendMessage(reference(fixture.attach('video/mp4', 100)))
    await expect(fixture.service.validate(input())).resolves.toBeUndefined()
  })

  it('counts transcript system content once in both live and restored branches', async () => {
    const fixture = createFixture()
    const system = { role: 'system' as const, content: 's'.repeat(10_000), timestamp: 1 }
    const user = { role: 'user' as const, content: 'u'.repeat(18_936_000), timestamp: 2 }
    fixture.history.appendMessage(system)
    fixture.history.appendMessage(user)
    await expect(fixture.service.validate(input())).resolves.toBeUndefined()
    fixture.active.messages = [system, user]
    await expect(fixture.service.validate(input())).resolves.toBeUndefined()
    fixture.active.messages = [system, { ...user, content: `${user.content}${'x'.repeat(20_000)}` }]
    await expect(fixture.service.validate(input())).rejects.toMatchObject({ code: 'MODEL_INPUT_TOO_LARGE' })
  })

  it('includes active input and pending steering when checking another input', async () => {
    const fixture = createFixture()
    const audio = fixture.attach('audio/wav', 8 * 1024 * 1024)
    fixture.active.messages = [reference(audio)]
    await expect(fixture.service.validate({ ...input(), attachments: [audio] })).resolves.toBeUndefined()
  })
})

function createFixture(overrides: Partial<InputModel> = {}) {
  const model: InputModel = {
    api: 'google-generative-ai',
    baseUrl: 'https://example.test',
    provider: 'fixture',
    id: 'fixture',
    name: 'Fixture',
    contextWindow: 1_000_000,
    maxTokens: 8192,
    input: ['text', 'image'],
    reasoning: false,
    pdfInput: true,
    audioInput: true,
    videoInput: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  }
  const records = new Map<string, AttachmentRecord>()
  const history = SessionManager.inMemory('/fixture')
  const active: { messages: AgentSession['messages'] | null } = { messages: null }
  const service = new ChatInputValidationService({
    models: { resolveAvailable: async () => model },
    attachments: { getInputMetadata: ids => ids.map(id => records.get(id)!) },
    paths: { conversationWorkspace: () => '/fixture' },
    sessions: { getReady: () => active.messages
      ? createReusableBuddySession({
          session: {
            model,
            messages: active.messages,
            systemPrompt: getCurrentSystemPrompt(active.messages),
            agent: { convertToLlm: async messages => messages },
          } as AgentSession,
          assertModelAccess: async () => model,
          inputReferences: { pending: null },
          runContext: { current: null },
          materializeInput: async value => value.prompt,
          shutdown: async () => {},
        })
      : null },
    tree: { preview: async () => history, snapshot: async () => null },
    recovery: { create: async () => ({ messages: [], recoveredImageCount: 0, missingAttachmentIds: [] }) },
    runs: { findById: () => null, findLatestForBranch: () => null },
    runInputs: { findByTriggeringMessageId: () => null },
  })
  return { service, history, active, attach(mimeType: string, sizeBytes: number) {
    const record: AttachmentRecord = { id: `file-${records.size}`, mimeType, sizeBytes, name: 'Fixture file', storedPath: '/fixture/input', messageId: 'message-1', conversationId: 'conversation-1', draftId: null, createdAt: '2026-09-12T00:00:00.000Z' }
    records.set(record.id, record)
    return record
  } }
}

function reference(record: AttachmentRecord) {
  return createBuddyInputReferenceMessage(createBuddyInputReference({
    messageId: `message-${record.id}`,
    prompt: 'Inspect the file',
    images: record.mimeType.startsWith('image/') ? [{ attachmentId: record.id, mimeType: record.mimeType }] : [],
    documents: record.mimeType.startsWith('image/') ? [] : [{ attachmentId: record.id, mimeType: record.mimeType as 'audio/wav' }],
  }), 0)
}

function input(): ChatInputValidationInput {
  return { conversationId: 'conversation-1', branchId: 'branch-1', modelId: 'fixture', providerId: 'fixture', contextWindow: null, maxTokens: null, prompt: 'Inspect this', attachments: [] }
}
