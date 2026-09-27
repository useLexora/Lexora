import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { createDesktopQuitLifecycle } from '../desktopQuitLifecycle'

describe('desktop quit lifecycle', () => {
  it('shares concurrent requests and commits only after saving and cleanup', async () => {
    const save = deferred<boolean>()
    const stopped = deferred<void>()
    const events: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      confirm: async () => {
        events.push('saving')
        return save.promise
      },
      dispose: async () => {
        events.push('cleanup')
        await stopped.promise
      },
      quit: () => {
        expect(lifecycle.committed).toBe(true)
        events.push('quit')
      },
    })
    const first = lifecycle.request()
    expect(lifecycle.request()).toBe(first)
    await Promise.resolve()
    expect(events).toEqual(['saving'])
    expect(lifecycle.quitting).toBe(false)
    save.resolve(true)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['saving', 'cleanup'])
    expect(lifecycle.quitting).toBe(true)
    expect(lifecycle.committed).toBe(false)
    stopped.resolve()
    await first
    expect(events).toEqual(['saving', 'cleanup', 'quit'])
    expect(lifecycle.request()).toBe(first)
  })

  it('keeps the application alive after cancellation and allows a later saved quit', async () => {
    let allowed = false
    const events: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      confirm: async () => allowed,
      dispose: async () => { events.push('cleanup') },
      quit: () => { events.push('quit') },
    })
    await lifecycle.request()
    expect(events).toEqual([])
    expect(lifecycle.quitting).toBe(false)
    expect(lifecycle.committed).toBe(false)
    allowed = true
    await lifecycle.request()
    expect(events).toEqual(['cleanup', 'quit'])
  })

  it('preserves explicit discard-on-failure for signal shutdown', async () => {
    const events: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      confirm: async options => options.discardDraftsOnFailure === true,
      dispose: async () => { events.push('cleanup') },
      quit: () => { events.push('quit') },
    })
    await lifecycle.request({ discardDraftsOnFailure: true })
    expect(events).toEqual(['cleanup', 'quit'])
    expect(lifecycle.committed).toBe(true)
  })

  it('does not commit when cleanup fails', async () => {
    const lifecycle = createDesktopQuitLifecycle({
      confirm: async () => true,
      dispose: async () => { throw new Error('Cleanup failed') },
      quit: () => { throw new Error('Unexpected quit') },
    })
    await expect(lifecycle.request()).rejects.toThrow('Cleanup failed')
    expect(lifecycle.committed).toBe(false)
  })

  it('passes an explicit restart request only after cleanup completes', async () => {
    const events: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      confirm: async () => true,
      dispose: async () => { events.push('cleanup') },
      quit: (restart) => { events.push(restart ? 'restart' : 'quit') },
    })
    await lifecycle.request({ restart: true })
    expect(events).toEqual(['cleanup', 'restart'])
  })
})
