import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { ApplicationDiagnostic, ApplicationDiagnosticReporter } from '../../../../../shared/diagnostics/applicationDiagnostic'
import type { ToolExecutionTiming } from '../../../../../shared/runs/toolExecutionPhase'
import type { AppendBuddyRunEventInput } from '../../../events/BuddyRunEvent'

import type { RunEventWriter } from '../../../events/RunEventPorts'
import { describe, expect, it, vi } from 'vitest'
import { PiEventBridge } from '../PiEventBridge'

describe('piEventBridge', () => {
  it('fills a settled tool outcome without reopening phase durations or accepting later updates', async () => {
    const { appended, channel } = createProjectionHarness()
    const identity = { toolCallId: 'cancelled', toolName: 'bash' }
    channel.projectToolExecutionPhase({ ...identity, phase: 'executing' })
    channel.projectToolExecutionPhase({ ...identity, phase: 'finished' })
    await channel.flush()
    const before = (appended.at(-1)!.payload as { timing: ToolExecutionTiming }).timing
    channel.projectToolExecutionPhase({ ...identity, phase: 'finished', outcome: 'cancelled' })
    channel.projectToolExecutionPhase({ ...identity, phase: 'finished', outcome: 'failed' })
    channel.projectToolExecutionPhase({ ...identity, phase: 'cleaning' })
    await channel.flush()
    expect(appended.at(-1)?.payload).toEqual({ ...identity, timing: { ...before, outcome: 'cancelled' } })
    expect(appended.filter(event => event.type === 'tool.phase')).toHaveLength(3)
  })

  it('persists nonoverlapping phase durations and resource owners without reopening completed tools', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const { appended, channel, emit } = createProjectionHarness()
      const identity = { toolCallId: 'timed', toolName: 'bash' }
      emit({ type: 'tool_execution_start', ...identity, args: { command: 'private-command' } })
      await channel.flush()
      now = 10
      await channel.projectToolExecutionAuthorized({ ...identity, arguments: {} })
      const first = { runId: 'first', title: 'First task', since: 1, state: 'active' as const }
      const second = { runId: 'second', since: 2, state: 'queued' as const }
      now = 20
      channel.projectToolExecutionPhase({ ...identity, phase: 'resource', waitingFor: first })
      now = 30
      channel.projectToolExecutionPhase({ ...identity, phase: 'resource', waitingFor: first })
      now = 40
      channel.projectToolExecutionPhase({ ...identity, phase: 'resource', waitingFor: second })
      now = 50
      channel.projectToolExecutionPhase({ ...identity, phase: 'executing', executionBasis: 'backend' })
      now = 70
      channel.projectToolExecutionPhase({ ...identity, phase: 'approval' })
      now = 100
      channel.projectToolExecutionPhase({ ...identity, phase: 'executing', executionBasis: 'backend' })
      now = 120
      channel.projectToolExecutionPhase({ ...identity, phase: 'cleaning' })
      now = 125
      emit({ type: 'tool_execution_end', ...identity, isError: false, result: { content: [], details: {} } })
      await channel.flush()
      channel.projectToolExecutionPhase({ ...identity, phase: 'executing', executionBasis: 'backend' })
      await channel.flush()
      const phases = appended.filter(event => event.type === 'tool.phase')
      const timings = phases.map(event => (event.payload as { timing: ToolExecutionTiming }).timing)
      expect(timings.filter(timing => timing.phase === 'resource').map(timing => timing.waitingFor)).toEqual([first, second])
      const executing = timings.find(timing => timing.phase === 'executing')
      expect(executing).toMatchObject({ durations: { resource: 30 } })
      expect(executing).not.toHaveProperty('waitingFor')
      expect(phases.at(-1)?.payload).toEqual({ ...identity, timing: { phase: 'finished', executionBasis: 'backend', durations: { authorizing: 10, preparing: 10, resource: 30, executing: 40, approval: 30, cleaning: 5 } } })
      expect(JSON.stringify(phases)).not.toContain('private-command')
    }
    finally { clock.mockRestore() }
  })

  it('preserves cancellation reported by Pi after a continuation settles without an aborted message', async () => {
    const { appended, channel, emit } = createProjectionHarness()
    emit({ type: 'agent_start' })
    emit({ type: 'agent_settled', aborted: true })
    await channel.flush()
    expect(channel.outcome.failureCode).toBe('MODEL_REQUEST_ABORTED')
    expect(appended.at(-1)).toMatchObject({ type: 'run.progress', payload: { phase: 'idle', toolName: null } })
  })

  it('correlates each model turn without recording messages or tool results', async () => {
    const recorded: ApplicationDiagnostic[] = []
    const { channel, emit } = createProjectionHarness(event => recorded.push(event))
    const message: AssistantMessage = {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'openai',
      model: 'fixture-model',
      content: [{ type: 'text', text: 'fixture-private-answer' }],
      usage: usage(),
      stopReason: 'stop',
      timestamp: 0,
    }
    emit({ type: 'turn_start' })
    emit({ type: 'turn_end', message, toolResults: [] })
    emit({ type: 'turn_start' })
    emit({ type: 'turn_end', message: { ...message, stopReason: 'error', errorMessage: 'fixture-private-error' }, toolResults: [] })
    emit({ type: 'turn_start' })
    await channel.settle()
    expect(recorded.map(event => [event.event, event.runId, event.turnId])).toEqual([
      ['pi.turn.started', 'run-1', 'run-1:1'],
      ['pi.turn.completed', 'run-1', 'run-1:1'],
      ['pi.turn.started', 'run-1', 'run-1:2'],
      ['pi.turn.failed', 'run-1', 'run-1:2'],
      ['pi.turn.started', 'run-1', 'run-1:3'],
      ['pi.turn.interrupted', 'run-1', 'run-1:3'],
    ])
    expect(JSON.stringify(recorded)).not.toContain('fixture-private')
  })
  it('publishes the latest terminal update when the window expires', async () => {
    vi.useFakeTimers()
    try {
      const { appended, channel, emit } = createProjectionHarness()
      emit({
        args: { command: 'printf output' },
        toolCallId: 'tool-terminal',
        toolName: 'powershell',
        type: 'tool_execution_start',
      })
      for (const output of ['first', 'first\nsecond']) {
        emit({
          args: { command: 'printf output' },
          partialResult: {
            content: [{ text: output, type: 'text' }],
            details: {},
          },
          toolCallId: 'tool-terminal',
          toolName: 'powershell',
          type: 'tool_execution_update',
        })
      }

      expect(appended).not.toContainEqual(expect.objectContaining({ type: 'tool.updated' }))

      await vi.runOnlyPendingTimersAsync()
      expect(appended.filter(event => event.type === 'tool.updated')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            presentation: expect.objectContaining({ output: 'first\nsecond' }),
          }),
        }),
      ])
      emit({
        isError: false,
        result: { content: [{ text: 'first\nsecond', type: 'text' }], details: {} },
        toolCallId: 'tool-terminal',
        toolName: 'powershell',
        type: 'tool_execution_end',
      })
      await channel.flush()
      expect(appended.findIndex(event => event.type === 'tool.updated'))
        .toBeLessThan(appended.findIndex(event => event.type === 'tool.completed'))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps the surviving order when terminal tools interleave', async () => {
    const { appended, channel, emit } = createProjectionHarness()
    for (const toolCallId of ['tool-a', 'tool-b']) {
      emit({
        args: { command: toolCallId },
        toolCallId,
        toolName: 'bash',
        type: 'tool_execution_start',
      })
    }
    for (const [toolCallId, output] of [
      ['tool-a', 'a1'],
      ['tool-b', 'b1'],
      ['tool-a', 'a2'],
    ] as const) {
      emit({
        args: { command: toolCallId },
        partialResult: {
          content: [{ text: output, type: 'text' }],
          details: {},
        },
        toolCallId,
        toolName: 'bash',
        type: 'tool_execution_update',
      })
    }
    emit({ type: 'agent_settled', aborted: false })

    await channel.flush()

    expect(appended.filter(event => event.type === 'tool.updated').map(event => (
      (event.payload as { presentation: { output: string } }).presentation.output
    ))).toEqual(['b1', 'a2'])
    emit({
      args: { path: '/workspace/example.txt' },
      toolCallId: 'tool-read',
      toolName: 'read',
      type: 'tool_execution_start',
    })
    for (const output of ['first', 'second']) {
      emit({
        args: { path: '/workspace/example.txt' },
        partialResult: { content: [{ text: output, type: 'text' }], details: {} },
        toolCallId: 'tool-read',
        toolName: 'read',
        type: 'tool_execution_update',
      })
    }
    await channel.flush()
    expect(appended.filter(event => event.type === 'tool.updated' && (event.payload as { toolCallId?: string }).toolCallId === 'tool-read')
      .map(event => (event.payload as { presentation: { output: string } }).presentation.output))
      .toEqual(['first', 'second'])
  })

  it('reports actual input context instead of billing total tokens', async () => {
    const appended: AppendBuddyRunEventInput[] = []
    let sequence = 0
    let listener: ((event: AgentSessionEvent) => void) | undefined
    const eventLog: RunEventWriter = {
      append: vi.fn(async (input: AppendBuddyRunEventInput) => {
        appended.push(input)
        return {
          ...input,
          createdAt: input.createdAt ?? '2026-09-03T00:00:00.000Z',
          sequence: ++sequence,
        }
      }),
      appendBatch: vi.fn(async inputs => inputs.map((input: AppendBuddyRunEventInput) => ({
        ...input,
        createdAt: input.createdAt ?? '2026-09-03T00:00:00.000Z',
        sequence: ++sequence,
      }))),
    }
    const getContextUsageBreakdown = (totalTokens: number) => ({
      mcpTokens: 0,
      messageTokens: totalTokens,
      skillTokens: 0,
      systemPromptTokens: 0,
      toolTokens: 0,
    })
    const bridge = new PiEventBridge({
      eventLog,
      usage: {
        record: vi.fn(async () => null),
        recordMessage: vi.fn(async () => ({
          cacheReadCost: 0,
          cacheReadTokens: 270_000,
          cacheWriteCost: 0,
          cacheWriteTokens: 0,
          createdAt: '2026-09-03T00:00:00.000Z',
          id: 'usage-1',
          inputCost: 0,
          inputTokens: 1_000,
          model: 'gpt-5.6-sol',
          outputCost: 0,
          outputTokens: 21_900,
          provider: 'openai-codex',
          purpose: 'turn',
          reasoningTokens: 20_000,
          runId: 'run-1',
          sourceEntryId: 'message-1',
          totalCost: 0,
          totalTokens: 292_900,
        })),
      },
    })
    const channel = bridge.createTurn({
      canonicalRoot: '/workspace',
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
      runId: 'run-1',
      session: {
        getContextUsageBreakdown,
        subscribe(nextListener) {
          listener = nextListener
          return () => {}
        },
      },
      timestamp: () => '2026-09-03T00:00:00.000Z',
    })
    channel.subscribe()
    const message: AssistantMessage = {
      api: 'openai-codex-responses',
      content: [{ type: 'text', text: 'Done' }],
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
      role: 'assistant',
      stopReason: 'stop',
      timestamp: Date.now(),
      usage: {
        cacheRead: 270_000,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 1_000,
        output: 21_900,
        reasoning: 20_000,
        totalTokens: 292_900,
      },
    }
    listener?.({ message, type: 'message_start' })
    listener?.({ message, type: 'message_end' })

    await channel.flush()

    expect(appended.find(event => event.type === 'context.usage.updated')?.payload).toMatchObject({
      messageTokens: 271_000,
      totalTokens: 271_000,
    })
  })

  it('propagates a failure to record the usage degradation fact', async () => {
    const degradationFailure = new Error('usage degradation event failed')
    const eventLog: RunEventWriter = {
      append: vi.fn(async () => {
        throw degradationFailure
      }),
      appendBatch: vi.fn(async () => []),
    }
    const bridge = new PiEventBridge({
      eventLog,
      usage: {
        record: vi.fn(async () => {
          throw new Error('usage recording failed')
        }),
        recordMessage: vi.fn(async () => null),
      },
    })
    const channel = bridge.createCompaction({
      canonicalRoot: '/workspace',
      model: 'model-1',
      provider: 'provider-1',
      runId: 'run-1',
      session: { subscribe: () => () => {} },
      timestamp: () => '2026-08-28T00:00:00.000Z',
    })

    await expect(channel.recordCompactionResult({
      estimatedTokensAfter: 100,
      firstKeptEntryId: 'entry-1',
      summary: 'summary',
      tokensBefore: 200,
      usage: usage(),
    })).rejects.toBe(degradationFailure)
  })
})

function usage(): Usage {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0.01,
      output: 0.02,
      total: 0.03,
    },
    input: 10,
    output: 5,
    totalTokens: 15,
  }
}

function createProjectionHarness(record?: ApplicationDiagnosticReporter): {
  appended: AppendBuddyRunEventInput[]
  channel: ReturnType<PiEventBridge['createTurn']>
  emit: (event: AgentSessionEvent) => void
} {
  const appended: AppendBuddyRunEventInput[] = []
  let sequence = 0
  let listener: ((event: AgentSessionEvent) => void) | undefined
  const eventLog: RunEventWriter = {
    append: vi.fn(async (input: AppendBuddyRunEventInput) => ({
      ...input,
      createdAt: input.createdAt ?? '2026-09-03T00:00:00.000Z',
      sequence: ++sequence,
    })),
    appendBatch: vi.fn(async (inputs: readonly AppendBuddyRunEventInput[]) => {
      appended.push(...inputs)
      return inputs.map(input => ({
        ...input,
        createdAt: input.createdAt ?? '2026-09-03T00:00:00.000Z',
        sequence: ++sequence,
      }))
    }),
  }
  const bridge = new PiEventBridge({
    record,
    eventLog,
    usage: {
      record: vi.fn(async () => null),
      recordMessage: vi.fn(async () => null),
    },
  })
  const channel = bridge.createTurn({
    canonicalRoot: '/workspace',
    model: 'gpt-5.6-sol',
    provider: 'openai-codex',
    runId: 'run-1',
    session: {
      subscribe(nextListener) {
        listener = nextListener
        return () => {}
      },
    },
    timestamp: () => '2026-09-03T00:00:00.000Z',
  })
  channel.subscribe()
  return {
    appended,
    channel,
    emit(event) {
      if (!listener)
        throw new Error('Pi event channel is not subscribed')
      listener(event)
    },
  }
}
