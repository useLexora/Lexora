import type { ClosePreparation } from '@buddy-shared/lifecycle/closePreparation'
import type { RendererLifecycleReport } from '@buddy-shared/lifecycle/serviceLifecycle'
import { deferred } from '@buddy-tests/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { createStartupFixture } from '../../../../electron/main/app/__tests__/startupFixture'
import { useDesktopLifecycle } from '../useDesktopLifecycle'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('workspace hydration', () => {
  it('waits for Runtime before loading data and keeps the surface covered until restoration completes', async () => {
    const gate = deferred<void>()
    const fixture = createFixture({ restore: () => gate.promise })
    await Promise.resolve()
    expect(fixture.lifecycle.dataReady.value).toBe(false)
    expect(fixture.reads.value).toBe(0)
    expect(await fixture.beforeQuit()).toBe(true)
    fixture.connect('runtime-1')
    await vi.waitFor(() => expect(fixture.reads.value).toBe(1))
    expect(fixture.lifecycle.dataReady.value).toBe(false)
    gate.resolve()
    await fixture.lifecycle.ready
    expect(fixture.lifecycle.dataReady.value).toBe(true)
    expect(fixture.lifecycle.state.value.status).toBe('ready')
  })

  it('automatically restores a new generation after an earlier request failed', async () => {
    const fixture = createFixture({ failFirst: true })
    fixture.connect('runtime-1')
    await fixture.lifecycle.ready
    expect(fixture.lifecycle.failed.value).toBe(true)
    expect(fixture.lifecycle.dataReady.value).toBe(false)
    fixture.connect('runtime-2')
    await vi.waitFor(() => expect(fixture.lifecycle.dataReady.value).toBe(true))
    expect(fixture.reads.value).toBe(2)
    expect(fixture.lifecycle.state.value.generation).toBe('runtime-2')
  })

  it('does not expose an old generation when a restart arrives during restoration', async () => {
    const gate = deferred<void>()
    const fixture = createFixture({ restore: () => gate.promise })
    fixture.connect('runtime-1')
    await vi.waitFor(() => expect(fixture.reads.value).toBe(1))
    fixture.connect('runtime-2')
    gate.resolve()
    await vi.waitFor(() => expect(fixture.lifecycle.dataReady.value).toBe(true))
    expect(fixture.reads.value).toBe(2)
    expect(fixture.lifecycle.state.value.generation).toBe('runtime-2')
  })
})

function createFixture(options: { restore?: () => Promise<void>, failFirst?: boolean, prepareQuit?: (signal: AbortSignal) => Promise<ClosePreparation | false>, flushSurface?: () => Promise<boolean> } = {}) {
  const { startup, connect, complete } = createStartupFixture()
  const reads = shallowRef(0)
  let beforeQuit = async (_requestId: string) => false
  let cancelQuit = (_requestId: string) => {}
  complete('desktop')
  const scope = effectScope()
  const lifecycle = scope.run(() => useDesktopLifecycle({
    prepareQuit: options.prepareQuit,
    flushSurface: options.flushSurface,
    api: { app: {
      startup: { getState: async () => startup.state, onStateChanged: startup.onStateChange.bind(startup), reportLifecycle: async (report: RendererLifecycleReport) => { startup.acceptRenderer(report) } },
      onBeforeQuit: (listener: (requestId: string) => Promise<boolean>) => {
        beforeQuit = listener
        return () => {}
      },
      onQuitPreparationCancelled: (listener: (requestId: string) => void) => {
        cancelQuit = listener
        return () => {}
      },
      onHidden: () => () => {},
    } },
    appState: {
      initialize: async () => true,
      refreshRuntimeDependentState: async () => {
        reads.value += 1
        if (options.failFirst && reads.value === 1)
          throw new Error('unavailable')
      },
      dispose: () => {},
      stores: { runtimeSupervisor: { restartRuntime: async () => true } },
    },
    automations: { initialize: async () => true, refresh: async () => true, dispose: () => {} },
    shell: { initialize: async () => {} },
    taskIndex: {
      initialize: async () => options.restore?.(),
      refresh: async () => options.restore?.(),
      dispose: () => {},
    },
  } as unknown as Parameters<typeof useDesktopLifecycle>[0]))!
  cleanups.push(() => scope.stop())
  return { lifecycle, reads, connect, beforeQuit: (id: string = crypto.randomUUID()) => beforeQuit(id), cancelQuit: (id: string) => cancelQuit(id) }
}

it('rejects a close approval invalidated while the workspace is flushing', async () => {
  let current = true
  const fixture = createFixture({ prepareQuit: async () => ({ validate: () => current }), flushSurface: async () => {
    current = false
    return true
  } })
  fixture.connect('runtime-1')
  await fixture.lifecycle.ready
  expect(await fixture.beforeQuit()).toBe(false)
})

it('cancels only the expired quit preparation and rejects its late result before flushing', async () => {
  const pending = deferred<ClosePreparation>()
  let lifetime: AbortSignal | undefined
  let flushed = 0
  const fixture = createFixture({ prepareQuit: async (signal) => {
    lifetime = signal
    return pending.promise
  }, flushSurface: async () => {
    flushed++
    return true
  } })
  fixture.connect('runtime-1')
  await fixture.lifecycle.ready
  const first = fixture.beforeQuit('first')
  await vi.waitFor(() => expect(lifetime).toBeDefined())
  const oldSignal = lifetime!
  fixture.cancelQuit('unrelated')
  expect(oldSignal.aborted).toBe(false)
  fixture.cancelQuit('first')
  expect(oldSignal.aborted).toBe(true)
  pending.resolve({ validate: () => true })
  expect(await first).toBe(false)
  expect(flushed).toBe(0)
  expect(await fixture.beforeQuit('retry')).toBe(true)
  expect(flushed).toBe(1)
})

it('keeps the app running when a document cannot save and flushes only after the close guard succeeds', async () => {
  let saved = false
  let flushed = false
  const fixture = createFixture({ prepareQuit: async () => saved ? { validate: () => saved } : false, flushSurface: async () => {
    flushed = true
    return true
  } })
  fixture.connect('runtime-1')
  await fixture.lifecycle.ready
  expect(await fixture.beforeQuit()).toBe(false)
  expect(flushed).toBe(false)
  saved = true
  expect(await fixture.beforeQuit()).toBe(true)
  expect(flushed).toBe(true)
})
