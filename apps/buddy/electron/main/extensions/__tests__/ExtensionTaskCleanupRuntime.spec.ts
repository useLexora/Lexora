import type { ExtensionTaskCleanupPreview, ExtensionTaskCleanupProgress } from '../../../../shared/extensions/extensionTaskCleanup'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { deferred } from '@buddy-tests/deferred'
import { expect, it } from 'vitest'

interface CleanupCommand {
  run: (options: { confirm: (preview: ExtensionTaskCleanupPreview, signal: AbortSignal) => boolean | Promise<boolean>, onProgress?: (progress: ExtensionTaskCleanupProgress) => unknown }) => Promise<unknown>
}

const progress: ExtensionTaskCleanupProgress = { phase: 'running', total: 2, processed: 1, deleted: 0, pending: 1, failed: 0, skipped: 0, errorCode: null }

async function runtime(execute: (context: { taskCleanup?: CleanupCommand }) => Promise<unknown>) {
  let receive!: (message: { id: string, method: string, params: unknown }) => Promise<void>
  let pagehide!: () => void
  const pending = new Map<string, ReturnType<typeof deferred<unknown>>>()
  const replies = new Map<string, { success: boolean, result: unknown }>()
  const source = await readFile(new URL('../runtime/host.js', import.meta.url), 'utf8')
  runInNewContext(`${source.replace(/^import .*\n/gm, '')}\ncommands.set('cleanup', execute); activated = true`, {
    execute,
    window: { lexoraExtensionHost: {
      subscribe: (callback: typeof receive) => { receive = callback },
      request: (method: string, params: { token: string }) => {
        if (method !== 'taskCleanup.run')
          return Promise.resolve(null)
        const result = deferred<unknown>()
        pending.set(params.token, result)
        return result.promise
      },
      reply: (id: string, success: boolean, result: unknown) => replies.set(id, { success, result }),
    } },
    location: { href: 'https://plugin.invalid/' },
    URL,
    AbortController,
    Worker: class {},
    createExtensionWorkers: () => ({}),
    createExtensionResourceClient: () => ({}),
    createExtensionNetworkClient: () => ({}),
    createExtensionInferenceClient: () => ({}),
    ExtensionHostEvents: class { events = {} },
    addEventListener: (_name: string, callback: () => void) => { pagehide = callback },
  })
  let sequence = 0
  const message = async (method: string, params: unknown) => {
    const id = String(++sequence)
    await receive({ id, method, params })
    return replies.get(id)!
  }
  return { pending, pagehide: () => pagehide(), command: (token: string | null) => message('command', { command: 'cleanup', cleanupToken: token }), progress: (token: string, value = progress) => message('taskCleanup.progress', { token, progress: value }), confirm: (token: string) => message('taskCleanup.confirm', { token, preview: { total: 2, skipped: 1 } }), cancel: (token: string) => message('taskCleanup.cancel', { token }) }
}

it('routes by command token, isolates callback failures and releases listeners before final return', async () => {
  const received: ExtensionTaskCleanupProgress[] = []
  const f = await runtime(async ({ taskCleanup }) => taskCleanup!.run({ confirm: () => true, onProgress: (value) => {
    received.push(value)
    if (received.length === 1)
      throw new Error('PLUGIN_CALLBACK_FAILED')
    return Promise.reject(new Error('PLUGIN_ASYNC_CALLBACK_FAILED'))
  } }))
  const run = f.command('current')
  expect((await f.progress('other')).success).toBe(true)
  expect(received).toEqual([])
  expect((await f.progress('current')).success).toBe(true)
  expect((await f.progress('current')).success).toBe(true)
  expect(received).toEqual([progress, progress])
  const summary = { ...progress, phase: 'completed', processed: 2, deleted: 1 }
  const result = { status: 'completed', results: [], summary }
  f.pending.get('current')!.resolve(result)
  expect(await run).toEqual({ success: true, result })
  await f.progress('current', { ...progress, phase: 'scanning', total: null, processed: 0 })
  expect(received).toHaveLength(2)
})

it('keeps concurrent command callbacks isolated and removes rejected and unloaded listeners', async () => {
  const received: number[] = []
  let index = 0
  const f = await runtime(async ({ taskCleanup }) => {
    const id = ++index
    return taskCleanup!.run({ confirm: () => true, onProgress: () => {
      received.push(id)
    } })
  })
  const first = f.command('first')
  const second = f.command('second')
  await f.progress('first')
  await f.progress('second')
  expect(received).toEqual([1, 2])
  f.pending.get('first')!.reject(new Error('EXTENSION_TASK_CLEANUP_BUSY'))
  expect(await first).toEqual({ success: false, result: 'EXTENSION_TASK_CLEANUP_BUSY' })
  await f.progress('first')
  await f.progress('second')
  expect(received).toEqual([1, 2, 2])
  f.pagehide()
  await f.progress('second')
  expect(received).toEqual([1, 2, 2])
  f.pending.get('second')!.resolve(null)
  await second
})

it('requires confirm before sending a request and does not expose cleanup outside a trusted invocation', async () => {
  let captured: CleanupCommand | undefined
  const f = await runtime(async ({ taskCleanup }) => {
    captured = taskCleanup
    return taskCleanup ? (taskCleanup.run as (options?: unknown) => Promise<unknown>)() : null
  })
  expect(await f.command(null)).toEqual({ success: true, result: null })
  expect(captured).toBeUndefined()
  expect(await f.command('missing')).toEqual({ success: false, result: 'EXTENSION_TASK_CLEANUP_CONFIRMATION_REQUIRED' })
  expect(f.pending.size).toBe(0)
  await expect(captured!.run({ confirm: () => true })).rejects.toThrow('EXTENSION_METHOD_DENIED')
})

it.each([true, false, 'true', 'throw'] as const)('requires a boolean confirmation response: %s', async (response) => {
  const f = await runtime(async ({ taskCleanup }) => taskCleanup!.run({ confirm: (preview, signal) => {
    expect(preview).toEqual({ total: 2, skipped: 1 })
    expect(Object.isFrozen(preview)).toBe(true)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    if (response === 'throw')
      throw new Error('EXTENSION_OPERATION_FAILED')
    return response as boolean
  } }))
  const run = f.command('current')
  expect(await f.confirm('other')).toEqual({ success: false, result: 'EXTENSION_TASK_CLEANUP_EXPIRED' })
  expect(await f.confirm('current')).toEqual(typeof response === 'boolean' ? { success: true, result: response } : { success: false, result: response === 'throw' ? 'EXTENSION_OPERATION_FAILED' : 'EXTENSION_INVALID_ARGUMENT' })
  expect(await f.confirm('current')).toEqual({ success: false, result: 'EXTENSION_TASK_CLEANUP_EXPIRED' })
  f.pending.get('current')!.resolve(null)
  await run
})

it.each(['cancel', 'pagehide', 'command-end'] as const)('aborts the local callback signal on %s and ignores late true', async (action) => {
  const started = deferred<AbortSignal>()
  const answer = deferred<boolean>()
  const commandEnd = deferred<void>()
  let cleanupRun: Promise<unknown> | undefined
  const f = await runtime(async ({ taskCleanup }) => {
    cleanupRun = taskCleanup!.run({ confirm: (_preview, signal) => {
      started.resolve(signal)
      return answer.promise
    } })
    if (action === 'command-end') {
      await commandEnd.promise
      return null
    }
    return cleanupRun
  })
  const run = f.command('current')
  const confirmation = f.confirm('current')
  const signal = await started.promise
  if (action === 'cancel') {
    await f.cancel('current')
  }
  else if (action === 'pagehide') {
    f.pagehide()
  }
  else {
    commandEnd.resolve()
    await run
  }
  expect(signal.aborted).toBe(true)
  expect(await confirmation).toEqual({ success: false, result: 'EXTENSION_TASK_CLEANUP_EXPIRED' })
  answer.resolve(true)
  expect(await f.confirm('current')).toEqual({ success: false, result: 'EXTENSION_TASK_CLEANUP_EXPIRED' })
  f.pending.get('current')!.resolve(null)
  await cleanupRun
  await run
})

it('consumes the command once and isolates in-flight confirmations by token', async () => {
  const answers = [deferred<boolean>(), deferred<boolean>()]
  const entered = [deferred<AbortSignal>(), deferred<AbortSignal>()]
  let index = 0
  const f = await runtime(async ({ taskCleanup }) => {
    const id = index++
    const run = taskCleanup!.run({ confirm: (_preview, signal) => {
      entered[id]!.resolve(signal)
      return answers[id]!.promise
    } })
    await expect(taskCleanup!.run({ confirm: () => true })).rejects.toThrow('EXTENSION_METHOD_DENIED')
    return run
  })
  const first = f.command('first')
  const second = f.command('second')
  const firstConfirm = f.confirm('first')
  const secondConfirm = f.confirm('second')
  const firstSignal = await entered[0]!.promise
  const secondSignal = await entered[1]!.promise
  await f.cancel('first')
  expect(firstSignal.aborted).toBe(true)
  expect(secondSignal.aborted).toBe(false)
  expect((await firstConfirm).success).toBe(false)
  answers[0]!.resolve(true)
  answers[1]!.resolve(true)
  expect(await secondConfirm).toEqual({ success: true, result: true })
  f.pending.get('first')!.resolve(null)
  f.pending.get('second')!.resolve(null)
  await Promise.all([first, second])
})
