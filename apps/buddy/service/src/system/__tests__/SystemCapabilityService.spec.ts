import type {
  SystemActionChange,
  SystemActionRequest,
  SystemHostPort,
  SystemTarget,
} from '../systemCapability'
import { describe, expect, it, vi } from 'vitest'

import {
  SystemActionPreparationRegistry,
  SystemCapabilityError,
  SystemCapabilityService,
} from '../systemCapability'
import { classifySystemTool } from '../systemToolContract'

const processTarget: SystemTarget = {
  allowedActions: ['terminate-process', 'kill-process'],
  displayName: 'Fixture Client',
  executable: '/opt/fixture-client/fixture-client',
  interruption: 'network',
  kind: 'process',
  pid: 4_123_031,
  instanceId: '9912345',
  startedAt: '2026-08-23T10:00:00.000Z',
}

const terminateRequest: SystemActionRequest = {
  action: 'terminate-process',
  reason: 'Restart the unresponsive client',
  target: {
    kind: 'process',
    name: 'fixture-client',
  },
}

describe('systemCapabilityService', () => {
  it('resolves a structured selector before approval without exposing private target identity', async () => {
    const host = createHost()
    const service = createService(host)

    const prepared = await service.prepareAction(
      'tool-1',
      terminateRequest,
      new AbortController().signal,
    )

    expect(host.resolveTargets).toHaveBeenCalledWith(
      terminateRequest.target,
      expect.any(AbortSignal),
    )
    expect(prepared.review.target).toEqual({
      displayName: 'Fixture Client',
      pid: 4_123_031,
      startedAt: '2026-08-23T10:00:00.000Z',
    })
    expect(JSON.stringify(prepared.review)).not.toContain('9912345')
    expect(JSON.stringify(prepared.review)).not.toContain('/opt/fixture-client/fixture-client')
    await expect(classifySystemTool(service, {
      input: terminateRequest,
      toolCallId: 'tool-approval',
      toolName: 'lexora_system_action',
      type: 'tool_call',
    }, new AbortController().signal)).resolves.toMatchObject({
      access: 'execute',
      forceAsk: true,
    })
  })

  it('refuses missing and ambiguous selectors before showing an approval', async () => {
    const host = createHost()
    const service = createService(host)
    vi.mocked(host.resolveTargets).mockResolvedValueOnce([])

    await expect(service.prepareAction(
      'tool-missing',
      terminateRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SYSTEM_TARGET_NOT_FOUND' })

    vi.mocked(host.resolveTargets).mockResolvedValueOnce([
      processTarget,
      { ...processTarget, pid: 4_123_032, instanceId: '9912346' },
    ])
    await expect(service.prepareAction(
      'tool-ambiguous',
      terminateRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SYSTEM_TARGET_AMBIGUOUS' })
  })

  it('binds execution to the exact approved tool call input', async () => {
    const host = createHost()
    const service = createService(host)
    await service.prepareAction('tool-1', terminateRequest, new AbortController().signal)

    await expect(service.act('tool-1', {
      ...terminateRequest,
      action: 'kill-process',
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'SYSTEM_ACTION_CHANGED',
    })
    expect(host.execute).not.toHaveBeenCalled()
  })

  it('revalidates process identity after approval and refuses a reused pid', async () => {
    const host = createHost()
    const service = createService(host)
    await service.prepareAction('tool-1', terminateRequest, new AbortController().signal)
    vi.mocked(host.readTarget).mockResolvedValue({
      ...processTarget,
      executable: '/usr/bin/unrelated',
      instanceId: '10000000',
    })

    await expect(service.act(
      'tool-1',
      terminateRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SYSTEM_TARGET_CHANGED' })
    expect(host.execute).not.toHaveBeenCalled()
  })

  it('requires a new explicit action after graceful termination needs escalation', async () => {
    const host = createHost()
    const service = createService(host)
    await service.prepareAction('tool-1', terminateRequest, new AbortController().signal)

    const receipt = await service.act(
      'tool-1',
      terminateRequest,
      new AbortController().signal,
    )

    expect(host.execute).toHaveBeenCalledOnce()
    expect(host.execute).toHaveBeenCalledWith(
      processTarget,
      'terminate-process',
      expect.any(AbortSignal),
    )
    expect(receipt).toMatchObject({
      status: 'needs-escalation',
      verified: false,
    })
    expect(receipt).not.toHaveProperty('nextTargetRef')
    await expect(service.act(
      'tool-1',
      terminateRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'SYSTEM_ACTION_NOT_PREPARED' })
  })

  it('expires internal preparations before execution', async () => {
    let now = Date.parse('2026-08-23T12:00:00.000Z')
    const host = createHost()
    const service = new SystemCapabilityService({
      actions: new SystemActionPreparationRegistry({
        now: () => now,
        ttlMs: 1_000,
      }),
      host,
    })
    await service.prepareAction('tool-1', terminateRequest, new AbortController().signal)
    now += 1_001

    await expect(service.act(
      'tool-1',
      terminateRequest,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'SYSTEM_ACTION_EXPIRED',
      name: SystemCapabilityError.name,
    })
    expect(host.execute).not.toHaveBeenCalled()
  })

  it('keeps execution confirmation when the post-action observation fails', async () => {
    const host = createHost()
    const service = new SystemCapabilityService({ host })
    const facts: SystemActionChange[] = []
    service.onDidChange(change => facts.push(change))
    await service.prepareAction('tool-1', terminateRequest, new AbortController().signal)
    vi.mocked(host.readTarget).mockResolvedValueOnce(processTarget).mockRejectedValueOnce(new Error('private-postcondition'))
    await expect(service.act('tool-1', terminateRequest, new AbortController().signal)).rejects.toThrow('private-postcondition')
    expect(facts.map(({ phase, effect }) => ({ phase, effect }))).toEqual([
      { phase: 'dispatched', effect: 'unknown' },
      { phase: 'confirmed', effect: 'confirmed' },
      { phase: 'failed', effect: 'confirmed' },
    ])
    expect(JSON.stringify(facts)).not.toContain('private-postcondition')
    await service.dispose()
  })

  it('waits for admitted execution and records an unknown result after cancellation', async () => {
    const host = createHost()
    const execution = Promise.withResolvers<void>()
    vi.mocked(host.execute).mockReturnValue(execution.promise)
    const service = new SystemCapabilityService({ host })
    const facts: SystemActionChange[] = []
    service.onDidChange(change => facts.push(change))
    await service.prepareAction('tool-1', terminateRequest, new AbortController().signal)
    const acting = service.act('tool-1', terminateRequest, new AbortController().signal)
    const rejected = expect(acting).rejects.toThrow('execution unknown')
    await vi.waitFor(() => expect(host.execute).toHaveBeenCalledOnce())
    let disposed = false
    const stopping = service.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    execution.reject(new Error('execution unknown'))
    await rejected
    await stopping
    expect(facts.at(-1)).toMatchObject({ phase: 'failed', effect: 'unknown', cancelled: true })
    expect(service.snapshot.pending).toBe(0)
  })

  it('keeps raw systemd identity internal to the host adapter', async () => {
    const rawUnit = 'app-fixture\\x2dclient@autostart.service'
    const displayId = 'app-fixture-client@autostart.service'
    const host = createHost()
    vi.mocked(host.resolveTargets).mockResolvedValue([{
      activeState: 'active',
      allowedActions: ['restart-service'],
      displayName: 'Fixture Client',
      displayId,
      interruption: 'network',
      kind: 'service',
      scope: 'user',
      serviceId: rawUnit,
    }])
    const service = createService(host)

    const prepared = await service.prepareAction('tool-service', {
      action: 'restart-service',
      reason: 'Recover the proxy client',
      target: {
        kind: 'service',
        scope: 'user',
        serviceId: displayId,
      },
    }, new AbortController().signal)

    expect(prepared.review.target).toEqual({
      displayName: 'Fixture Client',
      serviceId: displayId,
    })
    expect(JSON.stringify(prepared.review)).not.toContain(rawUnit)
  })
})

function createService(host: SystemHostPort): SystemCapabilityService {
  return new SystemCapabilityService({
    actions: new SystemActionPreparationRegistry({
      now: () => Date.parse('2026-08-23T12:00:00.000Z'),
    }),
    host,
  })
}

function createHost(): SystemHostPort {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    readTarget: vi.fn().mockResolvedValue(processTarget),
    resolveTargets: vi.fn().mockResolvedValue([processTarget]),
  }
}
