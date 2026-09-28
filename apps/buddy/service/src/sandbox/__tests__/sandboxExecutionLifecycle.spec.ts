import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxExecutionLifecycle } from '../sandboxExecutionLifecycle'

describe('sandbox execution deadline', () => {
  it('does not infer cancellation or process start from the cleanup abort signal', () => {
    const controller = new AbortController()
    const lifecycle = new SandboxExecutionLifecycle(controller.signal)
    const events: unknown[] = []
    lifecycle.onDidChange(event => events.push(event))
    lifecycle.begin()
    lifecycle.finish({ ok: false, code: 'SANDBOX_UNAVAILABLE' })
    controller.abort()
    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.started).toBe(false)
    expect(lifecycle.snapshot).toMatchObject({ phase: 'finished', started: false, cancellation: 'none' })
    expect(events).toMatchObject([{ kind: 'preparing' }, { kind: 'settled' }])
  })

  it('keeps cancellation requests distinct from the actual backend result', () => {
    const controller = new AbortController()
    const lifecycle = new SandboxExecutionLifecycle(controller.signal)
    const events: unknown[] = []
    lifecycle.onDidChange(event => events.push(event))
    lifecycle.begin()
    lifecycle.start()
    controller.abort()
    expect(lifecycle.snapshot).toMatchObject({ phase: 'running', started: true, cancellation: 'requested' })
    lifecycle.finish({ ok: false, code: 'SANDBOX_CANCELLED' })
    expect(events).toMatchObject([{ kind: 'preparing' }, { kind: 'started' }, { kind: 'cancel-requested' }, { kind: 'settled' }])
    expect(Object.isFrozen(lifecycle.snapshot.result)).toBe(true)
  })

  afterEach(() => vi.useRealTimers())

  it('bounds preparation separately from the command timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const lifecycle = new SandboxExecutionLifecycle(new AbortController().signal, 0.05, 1_000)
    await vi.advanceTimersByTimeAsync(900)
    expect(lifecycle.signal.aborted).toBe(false)
    lifecycle.start()
    await vi.advanceTimersByTimeAsync(49)
    expect(lifecycle.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(lifecycle.timedOut).toBe(true)
    expect(lifecycle.signal.aborted).toBe(true)
    lifecycle.finish()
  })

  it('does not let an approval suspend preparation indefinitely', async () => {
    vi.useFakeTimers()
    const lifecycle = new SandboxExecutionLifecycle(new AbortController().signal, 10, 100)
    await vi.advanceTimersByTimeAsync(100)
    expect(lifecycle.timedOut).toBe(true)
    expect(() => lifecycle.start()).toThrow()
    lifecycle.finish()
  })

  it('pauses execution for overlapping approvals and never restarts after completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const lifecycle = new SandboxExecutionLifecycle(new AbortController().signal, 1)
    lifecycle.start()
    await vi.advanceTimersByTimeAsync(500)
    let approveFirst!: (value: boolean) => void
    let approveSecond!: (value: boolean) => void
    const first = lifecycle.approve(() => new Promise((resolve) => {
      approveFirst = resolve
    }))
    const second = lifecycle.approve(() => new Promise((resolve) => {
      approveSecond = resolve
    }))
    await vi.advanceTimersByTimeAsync(60_000)
    approveFirst(true)
    expect(await first).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lifecycle.signal.aborted).toBe(false)
    lifecycle.finish()
    approveSecond(true)
    expect(await second).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
