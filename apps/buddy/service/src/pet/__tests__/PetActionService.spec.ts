import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import type { PetExecuteSequenceResult } from '../../../../shared/runtime/petProtocol'
import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { PetActionChange } from '../PetActionService'
import { describe, expect, it, vi } from 'vitest'
import { applicationDiagnosticSchema } from '../../../../shared/diagnostics/applicationDiagnostic'
import { observePetActionDiagnostics } from '../observePetActionDiagnostics'
import { PetActionService } from '../PetActionService'
import { classifyPetTool, PET_TOOL_NAME } from '../petToolContract'

function createPeer(result: unknown): RuntimeRpcPeerContract {
  return {
    close: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(() => () => {}),
    onRequest: vi.fn(() => () => {}),
    request: vi.fn(async () => result),
  }
}

describe('petActionService', () => {
  it.each([
    { status: 'completed', completedSteps: 2 },
    { status: 'failed', completedSteps: 1, code: 'PET_STEP_FAILED' },
    { status: 'interrupted', completedSteps: 1, reasonCode: 'admission.preemptedByHigherPriorityPlan' },
  ] satisfies PetExecuteSequenceResult[])('preserves a confirmed $status result in safe diagnostics', async (result) => {
    const service = new PetActionService({ peer: createPeer(result), eventSink: () => {} })
    const facts: PetActionChange[] = []
    const diagnostics: ApplicationDiagnostic[] = []
    service.onDidChange(change => facts.push(change))
    observePetActionDiagnostics(service, event => diagnostics.push(applicationDiagnosticSchema.parse(event)))
    await expect(service.execute({ macro: 'awaitApproval', runId: 'run-1', toolCallId: 'tool-1' })).resolves.toEqual(result)
    expect(facts.map(change => change.phase)).toEqual(['requested', 'host-confirmed', 'progress-recorded'])
    expect(diagnostics.map(event => event.event)).toEqual(['pet.action.requested', `pet.action.host_confirmed.${result.status}`, `pet.action.progress_recorded.${result.status}`])
    expect(diagnostics[1]).toMatchObject({ level: result.status === 'failed' ? 'warn' : 'info', count: result.completedSteps, runId: 'run-1', toolCallId: 'tool-1' })
    expect(diagnostics[1]!.errorCode).toBe(result.status === 'failed' ? result.code : undefined)
    expect(new Set(diagnostics.map(event => event.operationId)).size).toBe(1)
    expect(JSON.stringify(diagnostics)).not.toContain('awaitApproval')
    expect(Object.isFrozen(facts[1]) && 'result' in facts[1]! && Object.isFrozen(facts[1]!.result)).toBe(true)
    await service.dispose()
  })

  it('keeps transport loss unknown even after recording the legacy tool response', async () => {
    const peer = createPeer(null)
    vi.mocked(peer.request).mockRejectedValue(new Error('private transport details'))
    const service = new PetActionService({ peer, eventSink: () => {} })
    const facts: PetActionChange[] = []
    const diagnostics: ApplicationDiagnostic[] = []
    service.onDidChange(change => facts.push(change))
    observePetActionDiagnostics(service, event => diagnostics.push(applicationDiagnosticSchema.parse(event)))
    await service.execute({ macro: 'thinking', runId: 'run-1', toolCallId: 'tool-1' })
    expect(facts.map(change => change.phase)).toEqual(['requested', 'transport-unknown', 'progress-recorded'])
    expect(facts.at(-1)).toMatchObject({ phase: 'progress-recorded', result: null })
    expect(diagnostics.map(event => event.event)).toEqual(['pet.action.requested', 'pet.action.transport_unknown', 'pet.action.progress_recorded.unknown'])
    expect(diagnostics.every(event => event.count === undefined && event.errorCode === undefined)).toBe(true)
    expect(JSON.stringify(diagnostics)).not.toContain('private transport details')
    await service.dispose()
  })

  it('preserves host success while propagating a required progress write failure', async () => {
    const failure = new Error('private writer failure')
    const result = { status: 'completed', completedSteps: 1 } as const
    const service = new PetActionService({ peer: createPeer(result), eventSink: () => {
      throw failure
    } })
    const facts: PetActionChange[] = []
    const diagnostics: ApplicationDiagnostic[] = []
    service.onDidChange(change => facts.push(change))
    observePetActionDiagnostics(service, event => diagnostics.push(applicationDiagnosticSchema.parse(event)))
    await expect(service.execute({ macro: 'thinking', runId: 'run-1', toolCallId: 'tool-1' })).rejects.toBe(failure)
    expect(facts.at(-1)).toMatchObject({ phase: 'progress-failed', result })
    expect(diagnostics.at(-1)).toMatchObject({ event: 'pet.action.progress_failed.completed', level: 'warn' })
    expect(diagnostics.filter(event => event.event === 'pet.action.host_confirmed.completed')).toHaveLength(1)
    expect(diagnostics.some(event => event.event.endsWith('.failed') || event.event === 'pet.action.transport_unknown')).toBe(false)
    expect(JSON.stringify(diagnostics)).not.toContain('private writer failure')
    await service.dispose()
  })

  it('stops admission and drains the host response and accepted progress write before disposing its source', async () => {
    const host = Promise.withResolvers<PetExecuteSequenceResult>()
    const progress = Promise.withResolvers<void>()
    const progressStarted = Promise.withResolvers<void>()
    const peer = createPeer(null)
    vi.mocked(peer.request).mockReturnValue(host.promise)
    const service = new PetActionService({ peer, eventSink: async () => {
      progressStarted.resolve()
      await progress.promise
    } })
    const phases: string[] = []
    service.onDidChange(change => phases.push(change.phase))
    const executing = service.execute({ macro: 'thinking', runId: 'run-1', toolCallId: 'tool-1' })
    let disposed = false
    const stopping = service.dispose().then(() => {
      disposed = true
    })
    await expect(service.execute({ macro: 'thinking' })).rejects.toThrow('PET_SERVICE_STOPPED')
    expect(disposed).toBe(false)
    host.resolve({ status: 'completed', completedSteps: 1 })
    await progressStarted.promise
    expect(disposed).toBe(false)
    expect(phases).toEqual(['requested', 'host-confirmed'])
    progress.resolve()
    await Promise.all([executing, stopping])
    expect(disposed).toBe(true)
    expect(phases).toEqual(['requested', 'host-confirmed', 'progress-recorded'])
  })

  it('compiles approval into a bounded primitive and restores idle afterwards', async () => {
    const peer = createPeer({ status: 'completed', completedSteps: 1 })
    const events: unknown[] = []
    const service = new PetActionService({
      eventSink: event => events.push(event),
      peer,
    })

    await expect(service.execute({
      macro: 'awaitApproval',
      runId: 'run-1',
      toolCallId: 'tool-1',
    })).resolves.toEqual({ status: 'completed', completedSteps: 1 })

    expect(peer.request).toHaveBeenCalledWith(
      'host.pet.executeSequence',
      expect.objectContaining({
        priority: 30,
        requestId: expect.stringMatching(/^pet_/),
        steps: [{
          animation: 'approval',
          completionBehavior: 'restoreIdle',
          interruptPolicy: 'interruptible',
          kind: 'playAction',
          playback: {
            clipDurationMs: 2540,
            durationMs: 5000,
            kind: 'loopForDuration',
          },
          timeoutMs: 6000,
        }],
      }),
      20_000,
    )
    expect(events).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        type: 'tool.updated',
        payload: expect.objectContaining({
          macro: 'awaitApproval',
          presentation: {
            card: 'pet',
            description: null,
            macro: 'awaitApproval',
            status: 'completed',
          },
          status: 'completed',
          toolCallId: 'tool-1',
          toolName: 'lexora_buddy_pet',
        }),
      }),
    ])
  })

  it('classifies only the owned tool as a first-party visual action', () => {
    expect(classifyPetTool({ toolName: PET_TOOL_NAME })).toEqual({
      access: 'visual',
    })
    expect(classifyPetTool({ toolName: 'read' })).toBeNull()
  })

  it('normalizes an unavailable host without leaking its raw error', async () => {
    const peer = createPeer(null)
    vi.mocked(peer.request).mockRejectedValue(new Error('secret host detail'))
    const service = new PetActionService({ peer })

    await expect(service.execute({ macro: 'thinking' })).resolves.toEqual({
      code: 'PET_UNAVAILABLE',
      completedSteps: 0,
      status: 'failed',
    })
  })
})
