import { describe, expect, it } from 'vitest'
import { conversationRequestSchemas, conversationResponseSchemas } from '../../../shared/conversation/conversationApi'
import { notificationsResponseSchemas } from '../../../shared/notifications/notificationApi'
import { providersRequestSchemas } from '../../../shared/providers/providerApi'
import { runsRequestSchemas, runsResponseSchemas } from '../../../shared/runs/runApi'
import { spacesRequestSchemas, spacesResponseSchemas } from '../../../shared/spaces/spaceApi'

describe('localChatResponseSchemas', () => {
  it('separates conversation list activity summaries from conversation mutations', () => {
    const conversation = {
      activeBranchId: 'branch-1',
      approvalPolicy: 'policy',
      createdAt: '2026-08-20T00:00:00.000Z',
      deletedAt: null,
      executionProfile: 'workspace_write',
      id: 'conversation-1',
      modelSelection: null,
      spaceId: null,
      title: 'Conversation',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }

    expect(conversationResponseSchemas.conversation.parse(conversation)).toEqual(conversation)
    expect(conversationResponseSchemas.conversations.parse([{
      ...conversation,
      activity: 'awaiting_approval',
      automationOccurrence: null,
    }])).toMatchObject([{ activity: 'awaiting_approval' }])
    expect(() => conversationResponseSchemas.conversations.parse([conversation])).toThrow()
    expect(() => conversationResponseSchemas.conversations.parse([{
      ...conversation,
      activity: 'failed',
    }])).toThrow()
  })

  it('accepts strict provider and model management mutations', () => {
    expect(providersRequestSchemas.providerEnabled.parse({
      enabled: false,
      providerId: 'anthropic',
    })).toEqual({ enabled: false, providerId: 'anthropic' })
    expect(providersRequestSchemas.providerModelEnabled.parse({
      enabled: true,
      modelId: 'claude',
      providerId: 'anthropic',
    })).toEqual({ enabled: true, modelId: 'claude', providerId: 'anthropic' })
    expect(providersRequestSchemas.providerModelParameters.parse({
      modelId: 'claude',
      parameters: { contextWindow: 200_000, maxTokens: 32_000 },
      providerId: 'anthropic',
    })).toEqual({
      modelId: 'claude',
      parameters: { contextWindow: 200_000, maxTokens: 32_000 },
      providerId: 'anthropic',
    })
    expect(() => providersRequestSchemas.providerModelParameters.parse({
      modelId: 'claude',
      parameters: { contextWindow: 16_000, maxTokens: 32_000 },
      providerId: 'anthropic',
    })).toThrow()
    expect(providersRequestSchemas.providerManualModel.parse({
      model: {
        id: 'custom-model',
        input: ['text'],
        reasoning: false,
      },
      providerId: 'custom-provider',
    })).toEqual({
      model: {
        id: 'custom-model',
        input: ['text'],
        reasoning: false,
      },
      providerId: 'custom-provider',
    })
    expect(providersRequestSchemas.defaultModel.parse({
      model: {
        modelId: 'claude',
        providerId: 'anthropic',
        reasoning: null,
      },
    })).toEqual({
      model: {
        modelId: 'claude',
        providerId: 'anthropic',
        reasoning: null,
      },
    })
    expect(() => providersRequestSchemas.providerManualModel.parse({
      model: { id: '', maxTokens: 200_000, contextWindow: 128_000 },
      providerId: 'custom-provider',
    })).toThrow()
  })

  it('accepts typed attention notifications and rejects arbitrary actions', () => {
    const notification = {
      action: { type: 'open-model-settings' },
      attention: 'unseen',
      audience: 'device',
      id: 'local:model-source-parameters-updated',
      kind: 'model.source-parameters-updated',
      lifecycle: 'active',
      occurredAt: '2026-08-20T00:00:00.000Z',
      origin: 'local-runtime',
      payload: { modelCount: 2 },
      resolvedAt: null,
      revision: '2026-08-20T00:00:00.000Z',
    }

    expect(notificationsResponseSchemas.notificationList.parse({
      items: [notification],
      unseenCount: 1,
    })).toEqual({ items: [notification], unseenCount: 1 })
    expect(() => notificationsResponseSchemas.notificationList.parse({
      items: [{ ...notification, action: { type: 'open-url', url: 'https://example.com' } }],
      unseenCount: 1,
    })).toThrow()
    expect(() => notificationsResponseSchemas.notificationList.parse({
      items: [{
        ...notification,
        action: { conversationId: 'conversation-1', runId: 'run-1', type: 'open-run' },
        kind: 'run.completed',
        payload: { conversationId: 'conversation-1', errorCode: null, runId: 'run-1' },
        resolvedAt: notification.occurredAt,
      }],
      unseenCount: 1,
    })).toThrow()
  })

  it('accepts Buddy-owned runs and rejects provider implementation fields', () => {
    const run = {
      approvalPolicy: 'policy',
      branchId: 'branch-1',
      completedAt: null,
      conversationId: 'conversation-1',
      errorCode: null,
      executionProfile: 'workspace_write',
      id: 'run-1',
      modelId: 'model-1',
      providerId: 'anthropic',
      purpose: 'chat',
      reasoningLevel: null,
      startedAt: '2026-08-14T00:00:00.000Z',
      status: 'running',
      triggeringMessageId: 'message-1',
    }

    expect(runsResponseSchemas.runs.parse([run])).toEqual([run])
    expect(() => runsResponseSchemas.runs.parse([{
      ...run,
      piSessionFile: '/private/session.jsonl',
      runtime: 'codex',
    }])).toThrow()
  })

  it('accepts strict space create, update and response contracts', () => {
    const input = {
      memoryScope: 'personal_and_space' as const,
      name: '  资料整理  ',
      primaryDirectory: { id: null, root: '/home/example/Documents' },
    }
    expect(spacesRequestSchemas.spaceCreate.parse(input)).toEqual({
      memoryScope: 'personal_and_space',
      name: '资料整理',
      primaryDirectory: { id: null, root: '/home/example/Documents' },
    })
    expect(spacesRequestSchemas.spaceUpdate.parse({
      ...input,
      memoryScope: 'space_only',
      primaryDirectory: { id: 'directory-1', root: '/home/example/Lexora' },
      spaceId: 'space-1',
    })).toEqual({
      memoryScope: 'space_only',
      name: '资料整理',
      primaryDirectory: { id: 'directory-1', root: '/home/example/Lexora' },
      spaceId: 'space-1',
    })
    expect(() => spacesRequestSchemas.spaceCreate.parse({
      memoryScope: 'shared',
      name: 'Lexora',
      primaryDirectory: null,
    })).toThrow()
    expect(spacesResponseSchemas.space.parse({
      activeRunCount: 1,
      icon: 'folder',
      iconColor: 'default',
      additionalDirectories: [],
      createdAt: '2026-08-19T00:00:00.000Z',
      id: 'space-1',
      memoryScope: 'personal_and_space',
      name: 'Lexora',
      primaryDirectory: {
        accessGrantedAt: '2026-08-19T00:00:00.000Z',
        canonicalRoot: '/home/example/Lexora',
        createdAt: '2026-08-19T00:00:00.000Z',
        id: 'directory-1',
        resourcesTrustedAt: '2026-08-19T00:00:00.000Z',
        revision: 1,
        revokedAt: null,
        root: '/home/example/Lexora',
        spaceId: 'space-1',
        updatedAt: '2026-08-19T00:00:00.000Z',
      },
      revokedAt: null,
      updatedAt: '2026-08-19T00:00:00.000Z',
    })).toMatchObject({ activeRunCount: 1, memoryScope: 'personal_and_space' })
  })

  it('accepts strict cursor message pages and rejects unbounded response shapes', () => {
    const input = {
      branchId: 'branch-1',
      conversationId: 'conversation-1',
      cursor: 'opaque_cursor-1',
      limit: 100,
    }
    const message = {
      attachments: [{
        attachmentId: 'attachment-1',
        kind: 'image' as const,
        mimeType: 'image/png',
        name: 'reference.png',
        previewUrl: null,
        sizeBytes: 2048,
      }],
      branchId: 'branch-1',
      content: { text: 'hello' },
      conversationId: 'conversation-1',
      createdAt: '2026-08-14T00:00:00.000Z',
      id: 'message-1',
      role: 'user' as const,
      runId: null,
    }

    expect(conversationRequestSchemas.conversationMessages.parse(input)).toEqual(input)
    expect(conversationResponseSchemas.messagePage.parse({
      items: [message],
      nextCursor: 'opaque_cursor-2',
    })).toEqual({
      items: [message],
      nextCursor: 'opaque_cursor-2',
    })
    expect(() => conversationResponseSchemas.messagePage.parse({
      items: [message],
      nextCursor: null,
      total: 1,
    })).toThrow()
  })

  it('accepts a strict mixed conversation timeline page', () => {
    const input = {
      branchId: 'branch-child',
      conversationId: 'conversation-1',
      cursor: 'opaque_timeline_cursor',
      limit: 100,
    }
    const page = {
      changeSets: [],
      items: [{
        attachments: [],
        branchId: 'branch-root',
        content: { text: 'hello' },
        conversationId: 'conversation-1',
        createdAt: '2026-08-14T00:00:00.000Z',
        id: 'message-1',
        kind: 'message' as const,
        role: 'user' as const,
        runId: null,
      }, {
        branchId: 'branch-child',
        completedAt: '2026-08-14T00:00:02.000Z',
        conversationId: 'conversation-1',
        createdAt: '2026-08-14T00:00:01.000Z',
        errorCode: null,
        estimatedTokensAfter: 700,
        id: 'compact-1',
        kind: 'compaction' as const,
        status: 'completed' as const,
        tokensBefore: 1400,
      }],
      nextCursor: null,
      outputs: [],
      runEvents: [],
      runs: [],
    }

    expect(conversationRequestSchemas.conversationTimeline.parse(input)).toEqual(input)
    expect(conversationResponseSchemas.timelinePage.parse(page)).toEqual(page)
    expect(() => conversationResponseSchemas.timelinePage.parse({
      ...page,
      items: [{ ...page.items[1], commandArguments: 'private instructions' }],
    })).toThrow()
    const { runs: _runs, ...missingRuns } = page
    expect(() => conversationResponseSchemas.timelinePage.parse(missingRuns)).toThrow()
  })

  it('allows HTTP and HTTPS custom provider URLs without embedded credentials', () => {
    const provider = {
      api: 'openai-responses' as const,
      baseUrl: 'https://models.example.test/v1',
      description: 'OpenAI-compatible private endpoint',
      displayName: 'Example',
      enabled: true,
      id: 'example',
      models: [{
        contextWindow: 4096,
        id: 'model-1',
        input: ['text' as const],
        maxTokens: 1024,
        name: 'Model',
        reasoning: false,
      }],
    }

    for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://192.168.1.12:8153/v1', 'http://models.example.test/v1']) {
      expect(providersRequestSchemas.providerUpsert.parse({
        provider: { ...provider, baseUrl },
      })).toBeTruthy()
    }
    expect(() => providersRequestSchemas.providerUpsert.parse({
      provider: { ...provider, baseUrl: 'http://user:secret@models.example.test/v1' },
    })).toThrow()
    expect(() => providersRequestSchemas.providerUpsert.parse({
      provider: { ...provider, baseUrl: 'ftp://models.example.test/v1' },
    })).toThrow()
  })

  it('accepts a bounded conversation event tail and rejects ambiguous event scopes', () => {
    expect(runsRequestSchemas.runEvents.parse({
      conversationId: 'conversation-1',
      limit: 1_000,
    })).toEqual({
      conversationId: 'conversation-1',
      limit: 1_000,
    })
    expect(() => runsRequestSchemas.runEvents.parse({
      conversationId: 'conversation-1',
      runId: 'run-1',
    })).toThrow()
  })
})
