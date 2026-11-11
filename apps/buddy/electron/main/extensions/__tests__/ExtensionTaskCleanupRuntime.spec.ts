import type { ExtensionTaskCleanupProgress } from '../../../../shared/extensions/extensionTaskCleanup'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { deferred } from '@buddy-tests/deferred'
import { expect, it } from 'vitest'

interface CleanupCommand {
  run: (options?: { onProgress?: (progress: ExtensionTaskCleanupProgress) => unknown }) => Promise<unknown>
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
  return { pending, pagehide: () => pagehide(), command: (token: string | null) => message('command', { command: 'cleanup', cleanupToken: token }), progress: (token: string, value = progress) => message('taskCleanup.progress', { token, progress: value }) }
}

it('routes by command token, isolates callback failures and releases listeners before final return', async () => {
  const received: ExtensionTaskCleanupProgress[] = []
  const f = await runtime(async ({ taskCleanup }) => taskCleanup!.run({ onProgress: (value) => {
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
    return taskCleanup!.run({ onProgress: () => {
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

it('preserves run() without options and does not expose cleanup outside a trusted invocation', async () => {
  let captured: CleanupCommand | undefined
  const f = await runtime(async ({ taskCleanup }) => {
    captured = taskCleanup
    return taskCleanup ? taskCleanup.run() : null
  })
  expect(await f.command(null)).toEqual({ success: true, result: null })
  expect(captured).toBeUndefined()
  const run = f.command('legacy')
  await expect(captured!.run()).rejects.toThrow('EXTENSION_METHOD_DENIED')
  expect((await f.progress('legacy')).success).toBe(true)
  f.pending.get('legacy')!.resolve({ status: 'cancelled', results: [], summary: { ...progress, phase: 'cancelled' } })
  expect(await run).toMatchObject({ success: true, result: { status: 'cancelled', summary: { phase: 'cancelled' } } })
})
