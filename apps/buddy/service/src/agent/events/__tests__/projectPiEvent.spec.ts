import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { publicRunEventSchema, toPublicRunEvent } from '../../../../../shared/runs/publicRunEvent'

import {
  createPiEventProjectionState,
  projectPiEvent,
  projectToolExecutionAuthorized,
  projectToolExecutionDenied,
} from '../projectPiEvent'

describe('projectPiEvent retries', () => {
  it.each([3, Infinity])('preserves the %s budget and deadline through public JSON and clears it on settlement', (maxAttempts) => {
    const state = createPiEventProjectionState()
    const now = Date.parse('2026-09-21T00:00:00Z')
    const projection = projectPiEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts, delayMs: 2000, errorMessage: 'private upstream error' }, state, now)
    const retry = { attempt: 1, maxAttempts: maxAttempts === Infinity ? 'unlimited' : maxAttempts, retryAt: '2026-09-21T00:00:02.000Z' }
    expect(projection.events).toEqual([{ type: 'run.progress', payload: { phase: 'model_requesting', toolName: null, retry } }])
    const wire = JSON.parse(JSON.stringify(toPublicRunEvent({ ...projection.events[0]!, createdAt: new Date(now).toISOString(), runId: 'retry-run', sequence: 1 })))
    expect(publicRunEventSchema.parse(wire).payload).toEqual(projection.events[0]!.payload)
    expect(JSON.stringify(wire)).not.toContain('private upstream')
    projectPiEvent({ type: 'agent_start' }, state)
    expect(projectPiEvent({ type: 'turn_start' }, state).events).toEqual([{ type: 'run.progress', payload: { phase: 'model_requesting', toolName: null, retry: { ...retry, retryAt: null } } }])
    expect(projectPiEvent({ type: 'auto_retry_end', success: true, attempt: 1 }, state).events).toEqual([{ type: 'run.progress', payload: { phase: 'model_requesting', toolName: null } }])
    projectPiEvent({ type: 'auto_retry_start', attempt: 2, maxAttempts, delayMs: 4000, errorMessage: 'private' }, state, now)
    expect(projectPiEvent({ type: 'agent_settled', aborted: false }, state).events).toEqual([{ type: 'run.progress', payload: { phase: 'idle', toolName: null } }])
  })

  it.each([
    ['thinking_delta', 'model_thinking'],
    ['text_delta', 'model_responding'],
    ['toolcall_delta', 'preparing'],
  ] as const)('restores live activity on the first nonempty %s before the retried response finishes', (type, phase) => {
    const state = createPiEventProjectionState()
    const partial: AssistantMessage = {
      api: 'openai-completions',
      content: [],
      model: 'retry-fixture',
      provider: 'retry-fixture',
      role: 'assistant',
      stopReason: 'pending',
      timestamp: 1,
      usage: emptyUsage(),
    }
    projectPiEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '503 transient' }, state)
    projectPiEvent({ type: 'agent_start' }, state)
    projectPiEvent({ type: 'turn_start' }, state)
    projectPiEvent({ type: 'message_start', message: partial }, state)
    const update = (delta: string) => projectPiEvent({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type, contentIndex: 0, delta, partial },
    }, state)
    expect(update('').events.filter(event => event.type === 'run.progress')).toEqual([{
      type: 'run.progress',
      payload: { phase, toolName: null, retry: { attempt: 1, maxAttempts: 3, retryAt: null } },
    }])
    const recovered = update('Recovered content')
    expect(recovered.events.at(-1)).toEqual({
      type: 'run.progress',
      payload: { phase, toolName: null },
    })
    expect(update('More content').events.some(event => event.type === 'run.progress')).toBe(false)
    expect(projectPiEvent({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: '503 transient' }, state).events).toEqual([{
      type: 'run.progress',
      payload: { phase: 'model_requesting', toolName: null, retry: { attempt: 2, maxAttempts: 3, retryAt: expect.any(String) } },
    }])
  })

  it('projects summary retry attempts and clears retry progress after exhaustion', () => {
    const state = createPiEventProjectionState()
    projectPiEvent({ type: 'summarization_retry_scheduled', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'private' }, state)
    expect(projectPiEvent({ type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'overflow' }, state).events).toEqual([{
      type: 'run.progress',
      payload: { phase: 'model_requesting', toolName: null, retry: { attempt: 2, maxAttempts: 3, retryAt: null } },
    }])
    expect(projectPiEvent({ type: 'summarization_retry_finished' }, state).events).toEqual([{
      type: 'run.progress',
      payload: { phase: 'model_requesting', toolName: null },
    }])
    projectPiEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, delayMs: 2000, errorMessage: 'private' }, state)
    expect(projectPiEvent({ type: 'auto_retry_end', attempt: 1, success: false, finalError: 'private' }, state).events).toEqual([{
      type: 'run.progress',
      payload: { phase: 'model_requesting', toolName: null },
    }])
  })
})

describe('projectPiEvent compaction', () => {
  it('projects manual and automatic compaction without exposing Pi session details', () => {
    const state = createPiEventProjectionState()

    expect(projectPiEvent({
      reason: 'manual',
      type: 'compaction_start',
    }, state).events).toEqual([{
      payload: { reason: 'manual' },
      type: 'context.compaction.started',
    }])
    expect(projectPiEvent({
      aborted: false,
      reason: 'threshold',
      result: {
        estimatedTokensAfter: 400,
        firstKeptEntryId: 'private-pi-entry',
        summary: 'private summary',
        tokensBefore: 1_200,
      },
      type: 'compaction_end',
      willRetry: false,
    }, state).events).toEqual([{
      payload: {
        estimatedTokensAfter: 400,
        reason: 'threshold',
        tokensBefore: 1_200,
        willRetry: false,
      },
      type: 'context.compaction.completed',
    }])
  })

  it('normalizes abort and provider failures into stable product events', () => {
    const state = createPiEventProjectionState()
    const cancelled: AgentSessionEvent = {
      aborted: true,
      reason: 'manual',
      result: undefined,
      type: 'compaction_end',
      willRetry: false,
    }
    const failed: AgentSessionEvent = {
      aborted: false,
      errorMessage: 'secret provider response',
      reason: 'overflow',
      result: undefined,
      type: 'compaction_end',
      willRetry: true,
    }

    expect(projectPiEvent(cancelled, state).events).toEqual([{
      payload: { reason: 'manual', willRetry: false },
      type: 'context.compaction.cancelled',
    }])
    const projection = projectPiEvent(failed, state)
    expect(projection.events).toEqual([{
      payload: {
        errorCode: 'COMPACTION_FAILED',
        reason: 'overflow',
        willRetry: true,
      },
      type: 'context.compaction.failed',
    }])
    expect(JSON.stringify(projection)).not.toContain('secret provider response')
  })
})

describe('projectPiEvent product messages', () => {
  it.each(['PATH_NOT_FOUND', 'INVALID_PATH', 'VALIDATION_FAILED'])('projects %s as a tool failure', (errorCode) => {
    expect(projectToolExecutionDenied({
      denialCode: errorCode,
      toolCallId: 'tool-1',
      toolName: 'read',
    }).events).toEqual([{
      type: 'tool.failed',
      payload: { errorCode, toolCallId: 'tool-1', toolName: 'read' },
    }])
  })

  it('projects Pi lifecycle events onto one deduplicated run progress channel', () => {
    const state = createPiEventProjectionState()
    const assistantMessage: AssistantMessage = {
      api: 'openai-codex-responses',
      content: [],
      model: 'gpt-5.6',
      provider: 'openai-codex',
      role: 'assistant',
      stopReason: 'stop',
      timestamp: 1,
      usage: emptyUsage(),
    }

    expect(projectPiEvent({ type: 'agent_start' }, state).events).toEqual([{
      payload: { phase: 'preparing', toolName: null },
      type: 'run.progress',
    }])
    expect(projectPiEvent({ type: 'turn_start' }, state).events).toEqual([{
      payload: { phase: 'model_requesting', toolName: null },
      type: 'run.progress',
    }])
    expect(projectPiEvent({ type: 'turn_start' }, state).events).toEqual([])
    expect(projectPiEvent({
      message: assistantMessage,
      type: 'message_start',
    }, state).events).toEqual([
      {
        payload: { messageId: expect.any(String), role: 'assistant' },
        type: 'message.started',
      },
      {
        payload: { phase: 'model_streaming', toolName: null },
        type: 'run.progress',
      },
    ])
    expect(projectPiEvent({
      args: { command: 'pwd' },
      toolCallId: 'tool-1',
      toolName: 'bash',
      type: 'tool_execution_start',
    }, state).events).toEqual([
      expect.objectContaining({ type: 'tool.preparing' }),
      {
        payload: { phase: 'preparing', toolName: 'bash' },
        type: 'run.progress',
      },
    ])
    expect(projectToolExecutionAuthorized({
      arguments: { command: 'pwd' },
      toolCallId: 'tool-1',
      toolName: 'bash',
    }, state).events).toEqual([
      expect.objectContaining({ type: 'tool.started' }),
      {
        payload: { phase: 'tool_executing', toolName: 'bash' },
        type: 'run.progress',
      },
    ])
    expect(projectToolExecutionDenied({
      denialCode: 'READ_ONLY_PROFILE',
      toolCallId: 'tool-1',
      toolName: 'write',
    }).events).toEqual([{
      payload: {
        denialCode: 'READ_ONLY_PROFILE',
        toolCallId: 'tool-1',
        toolName: 'write',
      },
      type: 'tool.denied',
    }])
    expect(projectPiEvent({ type: 'agent_settled', aborted: false }, state).events).toEqual([{
      payload: { phase: 'idle', toolName: null },
      type: 'run.progress',
    }])
  })

  it.each([undefined, 'commentary', 'final_answer'] as const)('distinguishes %s text from thinking, tool arguments and empty message starts', (textPhase) => {
    const state = createPiEventProjectionState()
    const partial: AssistantMessage = { api: 'openai-responses', content: [{ type: 'text', text: '', textSignature: JSON.stringify({ v: 1, id: 'text', phase: textPhase }) }], model: 'fixture', provider: 'fixture', role: 'assistant', stopReason: 'pending', timestamp: 1, usage: emptyUsage() }
    expect(projectPiEvent({ type: 'message_start', message: partial }, state).events.at(-1)).toEqual({
      type: 'run.progress',
      payload: { phase: 'model_streaming', toolName: null },
    })
    const started = projectPiEvent({ type: 'message_update', message: partial, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial } }, state)
    expect(started.events.filter(event => event.type === 'run.progress')).toEqual(textPhase === 'commentary'
      ? []
      : [{
          type: 'run.progress',
          payload: { phase: 'model_responding', toolName: null },
        }])
    const thoughtEnded = projectPiEvent({ type: 'message_update', message: partial, assistantMessageEvent: { type: 'thinking_end', contentIndex: 1, content: 'Previous thought', partial } }, state)
    expect(thoughtEnded.events.filter(event => event.type === 'run.progress')).toEqual([])
    const ended = projectPiEvent({ type: 'message_update', message: partial, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Visible text', partial } }, state)
    expect(ended.events.filter(event => event.type === 'run.progress')).toEqual(textPhase === 'commentary'
      ? []
      : [{
          type: 'run.progress',
          payload: { phase: 'model_streaming', toolName: null },
        }])
    const preparing = projectPiEvent({ type: 'message_update', message: partial, assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, partial } }, state)
    expect(preparing.events).toEqual([{ type: 'run.progress', payload: { phase: 'preparing', toolName: null } }])
  })

  it('bounds and deduplicates generated Artifact facts without treating file changes as outputs', () => {
    const state = createPiEventProjectionState()
    const artifactIds = Array.from({ length: 20 }, (_, index) => `generated-image-${index + 1}`)
    const result = {
      content: [{ text: 'generated', type: 'text' as const }],
      details: { artifactIds: [artifactIds[0]!, ...artifactIds] },
    }
    const completed = projectPiEvent({
      isError: false,
      result,
      toolCallId: 'tool-image-bounded',
      toolName: 'lexora_image_generate',
      type: 'tool_execution_end',
    }, state)

    const expectedIds = artifactIds.slice(0, 16)
    expect(completed.events).toMatchObject([
      {
        payload: {
          presentation: {
            artifactIds: expectedIds,
          },
        },
        type: 'tool.completed',
      },
      {
        payload: {
          artifactIds: expectedIds,
          sourceToolCallId: 'tool-image-bounded',
          sourceToolName: 'lexora_image_generate',
        },
        type: 'output.produced',
      },
    ])

    const fileTool = { toolCallId: 'tool-write', toolName: 'write' }
    projectPiEvent({ type: 'tool_execution_start', ...fileTool, args: { path: 'site/index.html' } }, state)
    expect(projectPiEvent({ type: 'tool_execution_end', ...fileTool, isError: false, result }, state).events).toMatchObject([{
      type: 'tool.completed',
      payload: { toolName: 'write' },
    }])
  })

  it('preserves Codex commentary and final answer phases without joining their text', () => {
    const state = createPiEventProjectionState()
    const message: AssistantMessage = {
      api: 'openai-codex-responses',
      content: [
        {
          text: 'I will inspect the process first.',
          textSignature: JSON.stringify({
            id: 'message-commentary',
            phase: 'commentary',
            v: 1,
          }),
          type: 'text',
        },
        {
          text: 'The process is running normally.',
          textSignature: JSON.stringify({
            id: 'message-final',
            phase: 'final_answer',
            v: 1,
          }),
          type: 'text',
        },
      ],
      model: 'gpt-5.6',
      provider: 'openai-codex',
      role: 'assistant',
      stopReason: 'stop',
      timestamp: 1,
      usage: emptyUsage(),
    }
    const started = projectPiEvent({ message, type: 'message_start' }, state)
    const messageId = (started.events[0]?.payload as { messageId?: unknown }).messageId

    expect(projectPiEvent({
      assistantMessageEvent: {
        contentIndex: 0,
        delta: 'I will inspect',
        partial: message,
        type: 'text_delta',
      },
      message,
      type: 'message_update',
    }, state).events).toEqual([{
      payload: {
        contentIndex: 0,
        delta: 'I will inspect',
        messageId,
        phase: 'commentary',
      },
      type: 'message.delta',
    }])

    expect(projectPiEvent({ message, type: 'message_end' }, state)).toEqual({
      events: [
        {
          payload: {
            content: 'I will inspect the process first.',
            contentIndex: 0,
            kind: 'text',
            messageId,
            phase: 'commentary',
          },
          type: 'message.block.completed',
        },
        {
          payload: {
            content: { text: 'The process is running normally.', modelId: message.model, providerId: message.provider },
            messageId,
            phase: 'final_answer',
            role: 'assistant',
            stopReason: 'completed',
          },
          type: 'message.completed',
        },
      ],
      sourceMessageId: messageId,
    })
  })

  it('classifies unphased tool-use text as commentary', () => {
    const state = createPiEventProjectionState()
    const message: AssistantMessage = {
      api: 'openai-completions',
      content: [
        {
          thinking: 'Checking the pull request status',
          thinkingSignature: 'reasoning_content',
          type: 'thinking',
        },
        {
          text: 'CI is green. I will verify the merge state next.',
          type: 'text',
        },
        {
          arguments: { command: 'gh pr view 130' },
          id: 'tool-1',
          name: 'bash',
          type: 'toolCall',
        },
      ],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      role: 'assistant',
      stopReason: 'toolUse',
      timestamp: 1,
      usage: emptyUsage(),
    }
    const started = projectPiEvent({ message, type: 'message_start' }, state)
    const messageId = (started.events[0]?.payload as { messageId?: unknown }).messageId

    expect(projectPiEvent({ message, type: 'message_end' }, state)).toEqual({
      events: [{
        payload: {
          content: { text: 'CI is green. I will verify the merge state next.', modelId: message.model, providerId: message.provider },
          messageId,
          phase: 'commentary',
          role: 'assistant',
          stopReason: 'tool_use',
        },
        type: 'message.completed',
      }],
      sourceMessageId: messageId,
    })
  })

  it('classifies stable model failures', () => {
    for (const [errorMessage, failureCode] of [
      ['MODEL_INPUT_UNSUPPORTED', 'MODEL_INPUT_UNSUPPORTED'],
      ['EXTENSION_INFERENCE_RESOURCE_CHANGED', 'MODEL_RESOURCES_CHANGED'],
      ['EXTENSION_INFERENCE_CHECKSUM_MISMATCH', 'MODEL_RESOURCES_CHANGED'],
      ['EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE', 'MODEL_RESOURCES_UNAVAILABLE'],
      ['EXTENSION_INFERENCE_RESOURCE_NOT_EXECUTABLE', 'MODEL_RESOURCES_UNAVAILABLE'],
      ['EXTENSION_INFERENCE_LOAD_FAILED', 'MODEL_LOAD_FAILED'],
      ['EXTENSION_INFERENCE_RESOURCE_EXHAUSTED', 'MODEL_RESOURCE_EXHAUSTED'],
      ['EXTENSION_INFERENCE_PROCESS_EXITED', 'MODEL_PROCESS_EXITED'],
      ['EXTENSION_INFERENCE_CONFIGURATION_CHANGED', 'MODEL_CONFIGURATION_CHANGED'],
      ['RESOURCE_MATERIALIZATION_FAILED', 'RESOURCE_MATERIALIZATION_FAILED'],
      ['404 "当前 API 不支持所选模型 claude-opus-4-8"', 'MODEL_NOT_SUPPORTED'],
      ['401 Unauthorized: invalid API key', 'PROVIDER_AUTHENTICATION_FAILED'],
      ['403 Forbidden: access denied for this model', 'PROVIDER_ACCESS_DENIED'],
      ['429 Too Many Requests: rate limit exceeded', 'PROVIDER_RATE_LIMITED'],
      ['Stream ended without finish_reason', 'MODEL_STREAM_INCOMPLETE'],
      ['Request timed out while waiting for the model service', 'MODEL_REQUEST_TIMED_OUT'],
      ['fetch failed: ECONNREFUSED 127.0.0.1:4100', 'MODEL_SERVICE_UNREACHABLE'],
      ['503 Service Unavailable', 'MODEL_SERVICE_UNAVAILABLE'],
    ]) {
      const state = createPiEventProjectionState()
      const failedMessage: AssistantMessage = {
        api: 'openai-completions',
        content: [],
        errorMessage,
        model: 'model-1',
        provider: 'provider-1',
        role: 'assistant',
        stopReason: 'error',
        timestamp: 1,
        usage: emptyUsage(),
      }

      expect(projectPiEvent({ message: failedMessage, type: 'message_end' }, state)).toMatchObject({
        failureCode,
        failureMessage: errorMessage,
      })
    }
  })

  it('projects structured HTTP failures without disclosing request diagnostics', () => {
    const state = createPiEventProjectionState()
    const failedMessage: AssistantMessage = {
      api: 'openai-completions',
      content: [],
      errorMessage: 'authentication failed: Bearer fixture-secret',
      diagnostics: [{ type: 'model.request.failure', timestamp: 1, details: { status: 503 } }],
      model: 'model-1',
      provider: 'provider-1',
      role: 'assistant',
      stopReason: 'error',
      timestamp: 1,
      usage: emptyUsage(),
    }
    const projection = projectPiEvent({ message: failedMessage, type: 'message_end' }, state)
    expect(projection).toMatchObject({
      failureCode: 'MODEL_SERVICE_UNAVAILABLE',
      failureMessage: 'authentication failed: Bearer [redacted]',
    })
    expect(JSON.stringify(projection)).not.toContain('fixture-secret')
    expect(JSON.stringify(projection.events)).not.toContain('model.request.failure')
  })

  it('projects visible reasoning blocks without provider signatures', () => {
    const state = createPiEventProjectionState()
    const partial: AssistantMessage = {
      api: 'openai-codex-responses',
      content: [{
        thinking: 'Inspecting the current process state',
        thinkingSignature: 'private-provider-signature',
        type: 'thinking',
      }],
      model: 'gpt-5.6',
      provider: 'openai-codex',
      role: 'assistant',
      stopReason: 'stop',
      timestamp: 1,
      usage: emptyUsage(),
    }
    const started = projectPiEvent({ message: partial, type: 'message_start' }, state)
    const messageId = (started.events[0]?.payload as { messageId?: unknown }).messageId

    expect(projectPiEvent({
      assistantMessageEvent: { contentIndex: 0, partial, type: 'thinking_start' },
      message: partial,
      type: 'message_update',
    }, state).events).toEqual([{
      payload: {
        contentIndex: 0,
        kind: 'reasoning',
        messageId,
      },
      type: 'message.block.started',
    }, { type: 'run.progress', payload: { phase: 'model_thinking', toolName: null } }])
    expect(projectPiEvent({
      assistantMessageEvent: {
        contentIndex: 0,
        delta: 'Inspecting the current process state',
        partial,
        type: 'thinking_delta',
      },
      message: partial,
      type: 'message_update',
    }, state).events).toEqual([{
      payload: {
        contentIndex: 0,
        delta: 'Inspecting the current process state',
        kind: 'reasoning',
        messageId,
      },
      type: 'message.block.delta',
    }])
    const completed = projectPiEvent({
      assistantMessageEvent: {
        content: 'Inspecting the current process state',
        contentIndex: 0,
        partial,
        type: 'thinking_end',
      },
      message: partial,
      type: 'message_update',
    }, state)
    expect(completed.events).toEqual([{
      payload: {
        content: 'Inspecting the current process state',
        contentIndex: 0,
        kind: 'reasoning',
        messageId,
      },
      type: 'message.block.completed',
    }, { type: 'run.progress', payload: { phase: 'model_streaming', toolName: null } }])
    expect(JSON.stringify(completed)).not.toContain('private-provider-signature')
  })

  it.each([false, true])('preserves shell metadata and redacted terminal history when isError is %s', (isError) => {
    const state = createPiEventProjectionState({ canonicalRoot: '/workspace/space' })
    const tool = { toolCallId: 'tool-terminal', toolName: 'lexora_shell' }
    projectPiEvent({
      ...tool,
      args: { command: 'printf output' },
      type: 'tool_execution_start',
    }, state)
    const update = (text: string) => projectPiEvent({
      ...tool,
      args: { command: 'printf output' },
      partialResult: { content: [{ text, type: 'text' }], details: { shell: { dialect: 'powershell' } } },
      type: 'tool_execution_update',
    }, state)

    const rawFirst = 'Authorization: Bearer private-token\nAPI_KEY=private-key'
    const first = 'Authorization: Bearer [redacted]\nAPI_KEY=[redacted]'
    const initial = update(rawFirst)
    expect(initial.events[0]).toMatchObject({
      payload: { presentation: { card: 'terminal', output: first, shellDialect: 'powershell' } },
      type: 'tool.updated',
    })
    expect(update(`${rawFirst}\nsecond`).events[0]).toEqual({
      payload: {
        ...tool,
        presentationDelta: {
          card: 'terminal',
          outputDelta: '\nsecond',
          outputStart: first.length,
          truncated: false,
        },
      },
      type: 'tool.updated',
    })
    const boundedOutput = `${rawFirst}\nsecond${'\n'.repeat(128 * 1024)}`
    expect(update(`${boundedOutput} first overflow`).events[0]).toMatchObject({
      payload: { presentation: { truncated: true } },
    })
    expect(update(`${boundedOutput} second overflow`).events).toEqual([])
    const completed = projectPiEvent({
      ...tool,
      isError,
      result: { content: [{ text: isError ? 'aborted' : boundedOutput, type: 'text' }], details: {} },
      type: 'tool_execution_end',
    }, state)
    expect(completed.events[0]).toMatchObject({
      payload: { isError, presentation: { cwd: '.', exitCode: isError ? null : 0, signal: null, shellDialect: 'powershell', output: isError ? 'aborted' : expect.stringContaining(first) } },
      type: 'tool.completed',
    })
    for (const projection of [initial, completed]) {
      const publicEvent = toPublicRunEvent({ ...projection.events[0]!, createdAt: '2026-11-01T00:00:00Z', runId: 'shell-run', sequence: 1 })
      expect(publicEvent.payload).toMatchObject({ presentation: { card: 'terminal', shellDialect: 'powershell' } })
      expect(JSON.stringify(publicEvent)).not.toContain('private-')
    }
  })

  it('redacts sensitive values from edit diffs', () => {
    const state = createPiEventProjectionState()
    projectPiEvent({
      args: { path: 'config.ts' },
      toolCallId: 'tool-edit',
      toolName: 'edit',
      type: 'tool_execution_start',
    }, state)

    expect(projectPiEvent({
      isError: false,
      result: {
        content: [{ text: 'updated', type: 'text' }],
        details: { diff: '+ API_KEY=private-key' },
      },
      toolCallId: 'tool-edit',
      toolName: 'edit',
      type: 'tool_execution_end',
    }, state).events[0]).toMatchObject({
      payload: {
        presentation: {
          diff: '+ API_KEY=[redacted]',
        },
      },
    })
  })
})

function emptyUsage(): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  }
}
