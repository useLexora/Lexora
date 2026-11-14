import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { createDesktopQuitLifecycle } from '../desktopQuitLifecycle'

describe('desktop quit lifecycle', () => {
  it('captures the committed exit preference once and keeps Core alive when only Desktop exits', async () => {
    const saving = deferred<boolean>()
    const operations: string[] = []
    let preference: 'keep_service' | 'stop_service' = 'keep_service'
    const lifecycle = createDesktopQuitLifecycle({
      getExitBehavior: () => preference,
      closeDesktop: async () => { operations.push('desktop.closed') },
      confirm: () => saving.promise,
      dispose: async () => { operations.push('service.stopped') },
      quit: () => { operations.push('host.quit') },
      exit: () => { operations.push('host.forced') },
    })
    const first = lifecycle.request()
    preference = 'stop_service'
    expect(lifecycle.request()).toBe(first)
    saving.resolve(true)
    await first
    expect(operations).toEqual(['desktop.closed'])
    expect(lifecycle.committed).toBe(false)
    await lifecycle.request({ reason: 'service_stop' })
    expect(operations).toEqual(['desktop.closed', 'service.stopped', 'host.quit'])
  })

  it('hands a confirmed restart to Core and retries a rejected handoff without disposing Desktop', async () => {
    const accepted = deferred<void>()
    let failure = true
    let requests = 0
    const lifecycle = createDesktopQuitLifecycle({
      getExitBehavior: () => 'keep_service',
      confirm: async () => true,
      restartDesktop: async () => {
        requests++
        if (failure)
          throw new Error('SERVICE_NOT_READY')
        await accepted.promise
      },
      dispose: async () => { throw new Error('Core owns restart cleanup') },
      quit: () => { throw new Error('Core owns the next Desktop') },
      exit: () => { throw new Error('A rejected handoff must keep Desktop alive') },
    })
    await expect(lifecycle.request({ restart: true })).rejects.toThrow('SERVICE_NOT_READY')
    expect(lifecycle.quitting).toBe(false)
    failure = false
    const request = lifecycle.request({ restart: true })
    expect(lifecycle.request({ restart: true })).toBe(request)
    accepted.resolve()
    await request
    expect(requests).toBe(2)
    expect(lifecycle.committed).toBe(true)
  })

  it('shares concurrent requests and commits only after saving and cleanup', async () => {
    const save = deferred<boolean>()
    const stopped = deferred<void>()
    const events: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      exit: () => { throw new Error('Unexpected forced exit') },
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
    const concurrent = lifecycle.request()
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
    await Promise.all([first, concurrent])
    expect(events).toEqual(['saving', 'cleanup', 'quit'])
    await lifecycle.request()
    expect(events).toEqual(['saving', 'cleanup', 'quit'])
  })

  it('keeps the application alive after cancellation and allows a later saved quit', async () => {
    let allowed = false
    const events: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      exit: () => { throw new Error('Unexpected forced exit') },
      confirm: async () => allowed,
      dispose: async () => { events.push('cleanup') },
      quit: restart => events.push(restart ? 'restart' : 'quit'),
    })
    await lifecycle.request()
    expect(events).toEqual([])
    expect(lifecycle.quitting).toBe(false)
    expect(lifecycle.committed).toBe(false)
    allowed = true
    await lifecycle.request({ restart: true })
    expect(events).toEqual(['cleanup', 'restart'])
  })

  it('exits after cleanup fails without committing or running the installation', async () => {
    const operations: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      confirm: async () => true,
      dispose: async () => {
        operations.push('dispose')
        throw new Error('Cleanup failed')
      },
      quit: () => { operations.push('quit') },
      exit: () => { operations.push('exit') },
    })
    const pending = lifecycle.request({ reason: 'installation' }, async () => () => {
      operations.push('install')
    })
    await expect(pending).rejects.toThrow('Cleanup failed')
    expect(operations).toEqual(['dispose', 'exit'])
    expect(lifecycle.quitting).toBe(true)
    expect(lifecycle.committed).toBe(false)
  })

  it('leaves the application running if installer launch fails', async () => {
    const operations: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      exit: () => { throw new Error('Unexpected forced exit') },
      confirm: async () => true,
      dispose: async () => { operations.push('dispose') },
      quit: () => { operations.push('quit') },
    })
    await expect(lifecycle.request({ reason: 'installation' }, async () => {
      throw new Error('Launch failed')
    })).rejects.toThrow('Launch failed')
    expect(operations).toEqual([])
    expect(lifecycle.quitting).toBe(false)
  })
  it('completes native installation after resources have been closed', async () => {
    const operations: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      exit: () => { throw new Error('Unexpected forced exit') },
      confirm: async () => true,
      dispose: async () => { operations.push('dispose') },
      quit: () => { throw new Error('Unexpected ordinary quit') },
    })
    await lifecycle.request({ reason: 'installation' }, async () => {
      operations.push('stage')
      return () => {
        operations.push('native-install')
      }
    })
    expect(operations).toEqual(['stage', 'dispose', 'native-install'])
    expect(lifecycle.committed).toBe(true)
  })
})
