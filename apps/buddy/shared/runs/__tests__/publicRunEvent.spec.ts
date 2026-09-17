import { describe, expect, it } from 'vitest'
import { publicRunEventSchema, toPublicRunEvent } from '../publicRunEvent'

describe('public run event projection', () => {
  it('publishes bounded panel operation records independently of tool presentations', () => {
    const published = toPublicRunEvent(event('desktop.panel.changed', { action: 'open', actor: 'harness', privateTarget: '/private/file' }))
    expect(published.payload).toEqual({ action: 'open', actor: 'harness' })
    expect(publicRunEventSchema.safeParse(published).success).toBe(true)
    expect(project('desktop.panel.changed', { action: 'toggle', actor: 'harness' })).toEqual({})
  })

  it.each(['PATH_NOT_FOUND', 'INVALID_PATH', 'VALIDATION_FAILED'])('publishes %s without private failure details', (errorCode) => {
    const published = toPublicRunEvent(event('tool.failed', {
      errorCode,
      toolCallId: 'tool-1',
      toolName: 'read',
      cause: '/private/file.txt',
      arguments: { path: '/private/file.txt' },
    }))
    expect(published.payload).toEqual({ errorCode, toolCallId: 'tool-1', toolName: 'read' })
    expect(publicRunEventSchema.safeParse(published).success).toBe(true)
    expect(project('tool.failed', { errorCode: 'PRIVATE_FAILURE', toolCallId: 'tool-1' })).toEqual({ toolCallId: 'tool-1' })
  })

  it('preserves registered tool labels across public lifecycle events without publishing definitions', () => {
    for (const type of ['tool.preparing', 'tool.started', 'tool.completed']) {
      const published = toPublicRunEvent(event(type, {
        toolCallId: 'query-1',
        toolName: 'custom_query',
        toolLabel: '  Query local data  ',
        toolDefinition: { description: 'private', parameters: { token: 'private' } },
      }))
      expect(published.payload).toEqual({ toolCallId: 'query-1', toolName: 'custom_query', toolLabel: 'Query local data' })
      expect(publicRunEventSchema.safeParse(published).success).toBe(true)
    }
    expect(project('tool.started', { toolLabel: 'x'.repeat(300) })).toEqual({ toolLabel: 'x'.repeat(256) })
    for (const toolLabel of [undefined, null, '', '  ', 12, false, { label: 'private' }])
      expect(project('tool.started', { toolName: 'custom_query', toolLabel })).toEqual({ toolName: 'custom_query' })
  })

  it('replays a streamed answer and its output using only public fields', () => {
    const expected = [
      { type: 'run.progress', payload: { phase: 'tool_executing', toolName: 'bash' } },
      { type: 'message.delta', payload: { contentIndex: 2, delta: 'Hello', messageId: 'message-1', phase: 'commentary' } },
      { type: 'message.completed', payload: { content: { attachmentIds: ['image-1'], text: 'Hello' }, messageId: 'message-1', phase: 'final_answer', role: 'assistant', stopReason: 'completed' } },
      { type: 'output.produced', payload: { artifactIds: ['image-1'], sourceToolCallId: 'tool-1', sourceToolName: 'lexora_image_generate' } },
    ]
    expect(expected.map(({ type, payload }) => project(type, {
      ...payload,
      ...('content' in payload ? { content: { ...payload.content, metadata: 'private' } } : {}),
      privateResponseId: 'private',
      privateRuntimeState: 'private',
    }))).toEqual(expected.map(({ payload }) => payload))
  })

  it('replays interrupted recovery without local identifiers or diagnostic causes', () => {
    const expected = [
      { type: 'session.recovery.degraded', payload: { missingAttachmentCount: 1, recoveredImageCount: 2, source: 'sqlite' } },
      { type: 'session.continuity.degraded', payload: { errorCode: 'SESSION_STORAGE_UNAVAILABLE', source: 'pi_session' } },
      { type: 'usage.recording.degraded', payload: { errorCode: 'USAGE_RECORDING_FAILED', purpose: 'compaction' } },
      { type: 'run.failed', payload: { errorCode: 'MODEL_REQUEST_FAILED', errorMessage: 'The configured model does not exist' } },
    ]
    expect(expected.map(({ type, payload }) => project(type, {
      ...payload,
      cause: 'EACCES: /private/session.jsonl',
      missingAttachmentIds: ['attachment-private'],
      sqliteError: 'SQLITE_CONSTRAINT_TRIGGER: /private/buddy.db',
    }))).toEqual(expected.map(({ payload }) => payload))
    expect(project('message.interrupted', {
      content: { metadata: 'private', state: 'interrupted', text: 'Partial answer', truncated: true },
      messageId: 'message-1',
      reason: 'runtime_restarted',
      role: 'assistant',
      secret: 'private',
    })).toEqual({
      content: { state: 'interrupted', text: 'Partial answer', truncated: true },
      messageId: 'message-1',
      reason: 'runtime_restarted',
      role: 'assistant',
    })
  })

  it('publishes typed approval reviews without raw arguments or internal storage fields', () => {
    const review = {
      allowForTurn: false,
      card: 'automation',
      executionProfile: 'full_access',
      modelMode: 'pinned: offline-provider/offline-model',
      name: 'Daily review',
      operation: 'upsert',
      spaceId: null,
      promptSummary: 'Summarize the day',
      scheduleSummary: 'daily at 21:00',
      timezone: 'Asia/Shanghai',
      toolName: 'lexora_buddy_automation',
    }
    expect(project('approval.requested', {
      arguments: { token: 'private' },
      createdAt: '2026-08-16T00:00:00.000Z',
      id: 'approval-1',
      kind: 'automation',
      payload: review,
      resolvedAt: null,
      runId: 'run-1',
      status: 'pending',
      summary: 'Save automation',
      toolCallId: 'tool-1',
    })).toEqual({
      id: 'approval-1',
      kind: 'automation',
      review,
      status: 'pending',
      summary: 'Save automation',
      toolCallId: 'tool-1',
    })
  })

  it('keeps visible reasoning and terminal output while removing provider metadata', () => {
    const content = 'r'.repeat(5_000)
    expect(project('message.block.delta', {
      contentIndex: 1,
      delta: 'Visible reasoning',
      kind: 'reasoning',
      messageId: 'message-1',
      reasoningKind: 'summary',
      thinkingSignature: 'private',
    })).toEqual({ contentIndex: 1, delta: 'Visible reasoning', kind: 'reasoning', messageId: 'message-1' })
    expect(project('message.block.completed', {
      content,
      contentIndex: 1,
      kind: 'reasoning',
      messageId: 'message-1',
      reasoningKind: 'thinking',
      textSignature: 'private',
    })).toEqual({ content, contentIndex: 1, kind: 'reasoning', messageId: 'message-1' })

    const presentation = {
      card: 'terminal',
      command: 'printf safe',
      cwd: '../../__tests__',
      description: null,
      exitCode: null,
      output: 'first',
      signal: null,
      truncated: false,
    }
    expect(project('tool.updated', {
      arguments: { token: 'private' },
      presentation,
      toolCallId: 'tool-1',
      toolName: 'bash',
    })).toEqual({ presentation, toolCallId: 'tool-1', toolName: 'bash' })
    expect(project('tool.updated', {
      presentationDelta: { card: 'terminal', outputDelta: '\nsecond', outputStart: 5, privateState: 'private', truncated: false },
      privateRuntimeState: 'private',
      toolCallId: 'tool-1',
      toolName: 'bash',
    })).toEqual({
      presentationDelta: { card: 'terminal', outputDelta: '\nsecond', outputStart: 5, truncated: false },
      toolCallId: 'tool-1',
      toolName: 'bash',
    })
  })

  it('fails closed for unknown and obsolete event payloads', () => {
    expect(toPublicRunEvent(event('future.provider.trace', { authorization: 'Bearer private' })))
      .toEqual({ ...event('future.provider.trace', {}), payload: {} })
    expect(project('artifact.changed', { canonicalPath: '/private/article.md', operation: 'created' })).toEqual({})
  })

  it('bounds usage fields and exposes attribution without private prompts', () => {
    expect(project('usage.recorded', {
      inputCost: 0.01,
      provider: 'x'.repeat(5_000),
      sourceEntryId: 'pi-entry-private',
      totalCost: Number.NaN,
      totalTokens: 42,
    })).toEqual({ provider: 'x'.repeat(4_096), totalTokens: 42 })
    expect(project('context.usage.updated', {
      mcpTokens: 20,
      messageTokens: 400,
      model: 'model-a',
      privatePrompt: 'private',
      provider: 'provider-a',
      skillTokens: 30,
      systemPromptTokens: 100,
      toolTokens: 50,
      totalTokens: 600,
    })).toEqual({
      mcpTokens: 20,
      messageTokens: 400,
      model: 'model-a',
      provider: 'provider-a',
      skillTokens: 30,
      systemPromptTokens: 100,
      toolTokens: 50,
      totalTokens: 600,
    })
  })
})

function event(type: string, payload: unknown) {
  return { createdAt: '2026-08-16T00:00:00.000Z', payload, runId: 'run-1', sequence: 1, type }
}

function project(type: string, payload: unknown) {
  return toPublicRunEvent(event(type, payload)).payload
}
