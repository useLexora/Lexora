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

  it('permits quitting before any task state has been opened', async () => {
    const fixture = createFixture()
    expect(await fixture.beforeQuit()).toBe(true)
  })
})

function createFixture(options: { restore?: () => Promise<void>, failFirst?: boolean } = {}) {
  const { startup, connect, complete } = createStartupFixture()
  const reads = shallowRef(0)
  let beforeQuit = async () => false
  complete('desktop')
  const scope = effectScope()
  const lifecycle = scope.run(() => useDesktopLifecycle({
    api: { app: {
      startup: { getState: async () => startup.state, onStateChanged: startup.onStateChange.bind(startup), reportLifecycle: async (report: RendererLifecycleReport) => { startup.acceptRenderer(report) } },
      onBeforeQuit: (listener: () => Promise<boolean>) => {
        beforeQuit = listener
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
  return { lifecycle, reads, connect, beforeQuit: () => beforeQuit() }
}
