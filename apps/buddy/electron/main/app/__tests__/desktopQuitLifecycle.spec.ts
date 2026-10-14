import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { createDesktopQuitLifecycle } from '../desktopQuitLifecycle'

describe('desktop quit lifecycle', () => {
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

  it('preserves explicit discard-on-failure for signal shutdown', async () => {
    const events: string[] = []
    const lifecycle = createDesktopQuitLifecycle({
      exit: () => { throw new Error('Unexpected forced exit') },
      confirm: async options => options.discardDraftsOnFailure === true,
      dispose: async () => { events.push('cleanup') },
      quit: () => { events.push('quit') },
    })
    await lifecycle.request({ discardDraftsOnFailure: true })
    expect(events).toEqual(['cleanup', 'quit'])
    expect(lifecycle.committed).toBe(true)
  })

  it.each(['quit', 'installation'] as const)('exits after cleanup fails during %s without committing or running the completion action', async (reason) => {
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
    const input = reason === 'quit' ? {} : { reason: 'installation' as const }
    const prepare = reason === 'installation'
      ? async () => () => { operations.push('install') }
      : undefined
    const pending = lifecycle.request(input, prepare)
    await expect(pending).rejects.toThrow('Cleanup failed')
    expect(operations).toEqual(['dispose', 'exit'])
    expect(lifecycle.quitting).toBe(true)
    expect(lifecycle.committed).toBe(false)
  })

  it('hands installation off only after confirmation and before releasing application resources', async () => {
    const operations: string[] = []
    let allowed = false
    const lifecycle = createDesktopQuitLifecycle({
      exit: () => { throw new Error('Unexpected forced exit') },
      confirm: async () => allowed,
      dispose: async () => { operations.push('dispose') },
      quit: () => { operations.push('quit') },
    })
    const prepare = async () => {
      operations.push('installer')
    }
    await lifecycle.request({ reason: 'installation' }, prepare)
    expect(operations).toEqual([])
    allowed = true
    await lifecycle.request({ reason: 'installation' }, prepare)
    expect(operations).toEqual(['installer', 'dispose', 'quit'])
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
