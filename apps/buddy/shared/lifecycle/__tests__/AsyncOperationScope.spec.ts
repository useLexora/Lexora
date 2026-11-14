import { describe, expect, it } from 'vitest'
import { AsyncOperationScope } from '../AsyncOperationScope'

describe('asyncOperationScope', () => {
  it('registers work before synchronous execution and drains accepted work after closing', async () => {
    const unavailable = new Error('unavailable')
    const scope = new AsyncOperationScope(() => unavailable)
    const gate = Promise.withResolvers<number>()
    let drained = false
    let stopping!: Promise<void>
    const result = scope.track(() => {
      expect(scope.hasPending).toBe(true)
      scope.stopAccepting()
      stopping = scope.drain().then(() => {
        drained = true
      })
      return gate.promise
    })
    let accepted = false
    await expect(scope.track(() => {
      accepted = true
    })).rejects.toBe(unavailable)
    expect(accepted).toBe(false)
    expect(drained).toBe(false)
    expect(() => scope.assertAccepting()).toThrow(unavailable)
    gate.resolve(42)
    await expect(result).resolves.toBe(42)
    await stopping
    expect(scope.hasPending).toBe(false)
    scope.stopAccepting()
    await scope.drain()
    expect(scope.isAccepting).toBe(false)
  })
})
