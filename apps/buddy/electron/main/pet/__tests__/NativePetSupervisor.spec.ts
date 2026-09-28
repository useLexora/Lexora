import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { NativePetChildProcess } from '../NativePetSupervisor'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  createNativePetProcessFactory,
  NativePetSupervisor,
} from '../NativePetSupervisor'
import { registerPetHostRpc } from '../registerPetHostRpc'

class FakePetProcess extends EventEmitter implements NativePetChildProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid: number | undefined
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = []
  readonly messages: Array<Record<string, unknown>> = []
  autoExit = true
  #inputBuffer = ''

  constructor(pid?: number) {
    super()
    this.pid = pid
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.#inputBuffer += chunk
      while (this.#inputBuffer.includes('\n')) {
        const newline = this.#inputBuffer.indexOf('\n')
        const line = this.#inputBuffer.slice(0, newline)
        this.#inputBuffer = this.#inputBuffer.slice(newline + 1)
        if (line)
          this.messages.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    if (this.autoExit)
      this.exit(0)
    return true
  }

  ready(): void {
    this.stdout.write('event:ready\n')
  }

  exit(code: number | null = 1): void {
    this.emit('exit', code, null)
    this.stdout.end()
  }

  respond(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }
}

function createSupervisor(options: {
  restartDelaysMs?: readonly number[]
  stableResetMs?: number
} = {}) {
  const processes: FakePetProcess[] = []
  const openDesktop = vi.fn()
  const supervisor = new NativePetSupervisor({
    onOpenDesktop: openDesktop,
    readinessTimeoutMs: 1000,
    restartDelaysMs: options.restartDelaysMs ?? [5],
    stableResetMs: options.stableResetMs,
    spawnPet() {
      const process = new FakePetProcess(100 + processes.length)
      processes.push(process)
      return process
    },
  })
  return { openDesktop, processes, supervisor }
}

describe('nativePetSupervisor', () => {
  it.each([false, true])('releases an asynchronously failed spawn without requiring exit (stopping: %s)', async (stopping) => {
    const failed = new FakePetProcess()
    failed.autoExit = false
    const replacement = new FakePetProcess(101)
    const processes = [failed, replacement]
    const supervisor = new NativePetSupervisor({ diagnosticOutput: new PassThrough(), spawnPet: () => processes.shift()!, restartDelaysMs: [], stopTimeoutMs: 50 })
    const changes: Array<{ kind: string, status?: string }> = []
    supervisor.onDidChange(change => changes.push(change))
    try {
      supervisor.start()
      const stopped = stopping ? supervisor.stop() : undefined
      if (stopped) {
        await Promise.resolve()
        expect(supervisor.snapshot.retiring).toHaveLength(1)
      }
      failed.emit('error', Object.assign(new Error('spawn failed'), { code: 'EACCES' }))
      await expect(stopped ?? supervisor.stop()).resolves.toBeUndefined()
      expect(supervisor.snapshot).toMatchObject({ state: { status: 'stopped' }, generation: null, retiring: [] })
      expect(changes.filter(change => change.kind === 'process').map(change => change.status)).toContain('spawn-failed')
      expect(changes.some(change => change.status === 'exited' || change.status === 'stop-unknown')).toBe(false)
      supervisor.start()
      replacement.ready()
      await vi.waitFor(() => expect(supervisor.state).toMatchObject({ status: 'ready', pid: 101 }))
    }
    finally { await supervisor.dispose() }
  })

  it('does not confirm a spawned process has stopped after a process-control error', async () => {
    vi.useFakeTimers()
    const { supervisor, processes } = createSupervisor()
    const changes: Array<{ kind: string, status?: string, generation: string | null }> = []
    supervisor.onDidChange(change => changes.push(change))
    try {
      supervisor.start()
      processes[0]!.ready()
      await vi.runAllTicks()
      processes[0]!.autoExit = false
      processes[0]!.emit('error', new Error('process control failed'))
      const stopped = expect(supervisor.stop()).rejects.toThrow('PET_STOP_UNCONFIRMED')
      await vi.advanceTimersByTimeAsync(2000)
      await stopped
      expect(supervisor.state.status).toBe('stop-unknown')
      expect(supervisor.snapshot.retiring).toHaveLength(1)
      expect(() => supervisor.start()).toThrow('PET_STOP_UNCONFIRMED')
      processes[0]!.exit(0)
      expect(supervisor.state.status).toBe('stopped')
      expect(supervisor.snapshot.retiring).toEqual([])
      expect(changes.filter(change => change.kind === 'process').map(change => change.status)).toEqual(['stop-requested', 'stop-unknown', 'exited'])
    }
    finally { vi.useRealTimers() }
  })

  it('keeps a timed-out dispatched step unknown without sending a compensating action', async () => {
    vi.useFakeTimers()
    const { supervisor, processes } = createSupervisor()
    const changes: Array<{ kind: string, status?: string }> = []
    supervisor.onDidChange(change => changes.push(change))
    try {
      supervisor.start()
      processes[0]!.ready()
      await vi.runAllTicks()
      const execution = supervisor.executeSequence(sequence('fixture', 1))
      await vi.advanceTimersByTimeAsync(2000)
      await expect(execution).resolves.toMatchObject({ status: 'failed', code: 'PET_UNAVAILABLE' })
      expect(executeMessages(processes[0]!)).toHaveLength(1)
      expect(changes.filter(change => change.kind === 'step').map(change => change.status)).toEqual(['dispatched', 'unknown'])
      await supervisor.stop()
    }
    finally { vi.useRealTimers() }
  })
  it('reports a native pet process startup failure', () => {
    const diagnosticOutput = new PassThrough()
    const diagnostics: string[] = []
    diagnosticOutput.on('data', chunk => diagnostics.push(String(chunk)))
    const supervisor = new NativePetSupervisor({
      diagnosticOutput,
      restartDelaysMs: [],
      spawnPet() {
        throw new Error('missing executable')
      },
    })

    supervisor.start()

    expect(diagnostics.join('')).toContain(
      'Native pet process failed to start: Error: missing executable',
    )
    expect(supervisor.state).toEqual({ restartAttempt: 0, status: 'offline' })
  })

  it('spawns the pet with desktop session variables but without provider credentials', () => {
    const process = new FakePetProcess(99)
    const spawnPet = vi.fn((
      _command: string,
      _args: string[],
      _options: { env: NodeJS.ProcessEnv, stdio: 'pipe', windowsHide: true },
    ) => process)
    const factory = createNativePetProcessFactory({
      appPath: '/workspace/apps/buddy',
      env: {
        ANTHROPIC_API_KEY: 'secret-anthropic',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        DISPLAY: ':0',
        GITHUB_TOKEN: 'secret-github',
        LANG: 'zh_CN.UTF-8',
        LEXORA_HOME: '/home/example/.lexora-custom',
        PATH: '/usr/local/bin:/usr/bin',
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_RUNTIME_DIR: '/run/user/1000',
      },
      exists: () => true,
      isPackaged: false,
      resourcesPath: '/workspace/resources',
      spawnPet,
    })

    factory()

    expect(spawnPet.mock.calls[0]![0]).toBe('/workspace/apps/buddy/.output/build/native/debug/lexora-buddy-pet')
    const spawnedEnvironment = spawnPet.mock.calls[0]![2].env
    expect(spawnedEnvironment).toMatchObject({
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      DISPLAY: ':0',
      LANG: 'zh_CN.UTF-8',
      LEXORA_HOME: '/home/example/.lexora-custom',
      LEXORA_BUDDY_PET_EXIT_ON_STDIN_CLOSE: '1',
      PATH: '/usr/local/bin:/usr/bin',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_RUNTIME_DIR: '/run/user/1000',
    })
    expect(spawnedEnvironment).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(spawnedEnvironment).not.toHaveProperty('GITHUB_TOKEN')
  })

  it('keeps pet lifecycle independent when a Buddy Local Service host binding is disposed', async () => {
    const { processes, supervisor } = createSupervisor()
    const handlers = new Map<string, RuntimeRequestHandler>()
    const peer = {
      close: vi.fn(),
      notify: vi.fn(),
      onNotification: vi.fn(() => () => {}),
      onRequest: vi.fn((method: string, handler: RuntimeRequestHandler) => {
        handlers.set(method, handler)
        return () => handlers.delete(method)
      }),
      request: vi.fn(),
    } satisfies RuntimeRpcPeerContract

    supervisor.start()
    processes[0]!.ready()
    await new Promise(resolve => setImmediate(resolve))
    const disposeRuntimeBinding = registerPetHostRpc(peer, supervisor)
    disposeRuntimeBinding()

    expect(supervisor.state).toMatchObject({ status: 'ready', pid: 100 })
    expect(processes[0]!.killSignals).toEqual([])
    expect(handlers).toHaveLength(0)
  })

  it('restarts after a pet crash and forwards its open desktop event', async () => {
    vi.useFakeTimers()
    const { openDesktop, processes, supervisor } = createSupervisor()
    supervisor.start()
    processes[0]!.ready()
    await vi.runAllTicks()
    processes[0]!.stdout.write('event:open_chat\n')
    await vi.runAllTicks()
    expect(openDesktop).toHaveBeenCalledOnce()

    processes[0]!.exit(1)
    await vi.advanceTimersByTimeAsync(5)
    expect(processes).toHaveLength(2)
    expect(supervisor.state.status).toBe('starting')
    processes[1]!.ready()
    await vi.runAllTicks()
    expect(supervisor.state).toMatchObject({ status: 'ready', pid: 101 })
    vi.useRealTimers()
  })

  it('does not reset the restart budget until the pet stays ready for the stable window', async () => {
    vi.useFakeTimers()
    const { processes, supervisor } = createSupervisor({
      restartDelaysMs: [5, 10],
      stableResetMs: 100,
    })
    supervisor.start()
    processes[0]!.ready()
    await vi.runAllTicks()
    processes[0]!.exit()
    await vi.advanceTimersByTimeAsync(5)
    processes[1]!.ready()
    await vi.runAllTicks()
    processes[1]!.exit()

    await vi.advanceTimersByTimeAsync(5)
    expect(processes).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5)
    expect(processes).toHaveLength(3)
    await supervisor.stop()
    vi.useRealTimers()
  })

  it('serializes concurrent higher-priority sequence admission', async () => {
    const { processes, supervisor } = createSupervisor()
    supervisor.start()
    const process = processes[0]!
    process.ready()
    await new Promise(resolve => setImmediate(resolve))
    const first = supervisor.executeSequence(sequence('first', 1))
    await vi.waitUntil(() => executeMessages(process).length === 1)
    const second = supervisor.executeSequence(sequence('second', 2))
    const third = supervisor.executeSequence(sequence('third', 3))

    try {
      await vi.waitUntil(() => interruptMessages(process).length > 0)
      expect(interruptMessages(process)).toHaveLength(1)
      respondInterrupted(process, executeMessages(process)[0]!)
      await vi.waitUntil(() => executeMessages(process).length === 2)
      await vi.waitUntil(() => interruptMessages(process).length === 2)
      respondInterrupted(process, executeMessages(process)[1]!)
      await vi.waitUntil(() => executeMessages(process).length === 3)
      respondCompleted(process, executeMessages(process)[2]!)

      await expect(first).resolves.toMatchObject({ status: 'interrupted' })
      await expect(second).resolves.toMatchObject({ status: 'interrupted' })
      await expect(third).resolves.toEqual({ completedSteps: 1, status: 'completed' })
    }
    finally {
      await supervisor.stop()
      await Promise.allSettled([first, second, third])
    }
  })
})

function sequence(requestId: string, priority: number) {
  return {
    priority,
    requestId,
    steps: [{
      after: 'idle' as const,
      interruptPolicy: 'interruptible' as const,
      kind: 'moveByPath' as const,
      path: [{ kind: 'home' as const }],
      timeoutMs: 1000,
    }],
  }
}

function executeMessages(process: FakePetProcess) {
  return process.messages.filter(message => message.type === 'executeStep')
}

function interruptMessages(process: FakePetProcess) {
  return process.messages.filter(message => message.type === 'interruptStep')
}

function respondInterrupted(process: FakePetProcess, request: Record<string, unknown>): void {
  process.respond({
    correlationId: request.messageId,
    protocolVersion: 1,
    reasonCode: 'admission.preemptedByHigherPriorityPlan',
    stepId: request.stepId,
    type: 'stepInterrupted',
  })
}

function respondCompleted(process: FakePetProcess, request: Record<string, unknown>): void {
  process.respond({
    correlationId: request.messageId,
    elapsedMs: 1,
    protocolVersion: 1,
    stepId: request.stepId,
    type: 'stepCompleted',
  })
}
