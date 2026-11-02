import { deferred } from '@buddy-tests/deferred'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_OPERATION_TIMEOUT_MS, BrowserDebugger } from '../BrowserDebugger'
import { BrowserHostError } from '../BrowserHostError'

function fixture(onAbort?: (reason: Error) => Promise<void>) {
  let attached = false
  const commands = new Map<string, ReturnType<typeof deferred<unknown>>>()
  const port = {
    attach: () => { attached = true },
    detach: () => { attached = false },
    isAttached: () => attached,
    sendCommand: (method: string) => {
      const command = deferred<unknown>()
      commands.set(method, command)
      return command.promise
    },
  }
  const debuggerConnection = new BrowserDebugger(port, { onAbort })
  debuggerConnection.ensureAttached()
  return { commands, debuggerConnection, port }
}

describe('browser debugger lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('settles concurrent commands independently until the first deadline aborts the guest', async () => {
    const destroyed = deferred<void>()
    const { commands, debuggerConnection, port } = fixture(() => destroyed.promise)
    const fast = debuggerConnection.sendCommand('fast')
    const slow = debuggerConnection.sendCommand('slow')
    const late = debuggerConnection.sendCommand('late')
    const results = Promise.allSettled([slow, late])
    commands.get('fast')!.resolve({ ok: true })
    await expect(fast).resolves.toEqual({ ok: true })
    let settled = false
    void results.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(BROWSER_OPERATION_TIMEOUT_MS)
    expect(port.isAttached()).toBe(false)
    expect(debuggerConnection.disposed).toBe(true)
    expect(debuggerConnection.hasPendingOperations).toBe(true)
    commands.get('late')!.resolve({ stale: true })
    await Promise.resolve()
    expect(settled).toBe(false)

    destroyed.resolve()
    const failures = await results
    expect(failures).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'BROWSER_PAGE_UNRESPONSIVE' }) },
      { status: 'rejected', reason: expect.objectContaining({ code: 'BROWSER_PAGE_UNRESPONSIVE' }) },
    ])
    expect(debuggerConnection.hasPendingOperations).toBe(false)
    expect(() => debuggerConnection.ensureAttached()).toThrow(BrowserHostError)
    await expect(debuggerConnection.sendCommand('new')).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    expect(commands.has('new')).toBe(false)
  })

  it('dispose waits for owner cleanup even when the underlying command succeeds late', async () => {
    const destroyed = deferred<void>()
    const { commands, debuggerConnection } = fixture(() => destroyed.promise)
    const result = debuggerConnection.sendCommand('pending')
    const rejection = expect(result).rejects.toMatchObject({ code: 'BROWSER_PAGE_FAILED' })
    debuggerConnection.dispose()
    const cleanup = debuggerConnection.abort(new Error('second reason must not replace first'))
    commands.get('pending')!.resolve('late success')
    await Promise.resolve()
    expect(debuggerConnection.hasPendingOperations).toBe(true)
    destroyed.resolve()
    await cleanup
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not claim transport release when detach fails, but lets the owner prove guest destruction', async () => {
    const destroyed = deferred<void>()
    const { debuggerConnection, port } = fixture(() => destroyed.promise)
    port.detach = () => {
      throw new Error('detach failed')
    }
    const pending = debuggerConnection.sendCommand('pending')
    const result = Promise.allSettled([pending])
    const cleanup = debuggerConnection.abort(new Error('cancel'))
    expect(debuggerConnection.hasPendingOperations).toBe(true)
    destroyed.resolve()
    await cleanup
    expect(await result).toEqual([{ status: 'rejected', reason: expect.objectContaining({ message: 'cancel' }) }])
  })

  it('bounds standalone commands by confirmed transport detachment and keeps idle borrowed attachments', async () => {
    const { debuggerConnection, port } = fixture()
    const failure = expect(debuggerConnection.sendCommand('pending')).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    await vi.advanceTimersByTimeAsync(BROWSER_OPERATION_TIMEOUT_MS)
    await failure
    expect(port.isAttached()).toBe(false)

    port.attach()
    const borrowed = new BrowserDebugger(port)
    borrowed.ensureAttached()
    borrowed.dispose()
    await Promise.resolve()
    expect(port.isAttached()).toBe(true)
  })

  it('retains pending operations when standalone detachment cannot be confirmed', async () => {
    const { debuggerConnection, port } = fixture()
    port.detach = () => {}
    void debuggerConnection.sendCommand('pending')
    await expect(debuggerConnection.abort(new Error('cancel'))).rejects.toMatchObject({ code: 'BROWSER_PAGE_UNRESPONSIVE' })
    expect(debuggerConnection.hasPendingOperations).toBe(true)
    expect(port.isAttached()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
