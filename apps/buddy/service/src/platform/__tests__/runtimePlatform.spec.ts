import type { RuntimePreferences } from '../../../../shared/runtime/runtimePreferences'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RUNTIME_PREFERENCES } from '../../../../shared/runtime/runtimePreferences'
import { bindRuntimePreferences } from '../../agent/sessions/bindRuntimePreferences'

describe('runtime platform capabilities', () => {
  it('keeps a preference update that overtakes its initial snapshot and releases the subscription', async () => {
    const snapshot = Promise.withResolvers<RuntimePreferences>()
    const applied: unknown[] = []
    let listening = false
    const binding = bindRuntimePreferences({
      get: () => snapshot.promise,
      subscribe(apply) {
        listening = true
        apply({ ...DEFAULT_RUNTIME_PREFERENCES, cacheWarming: 'streaming', modelRetryLimit: 'unlimited' })
        return () => {
          listening = false
        }
      },
    }, value => applied.push(value))
    snapshot.resolve({ ...DEFAULT_RUNTIME_PREFERENCES, cacheWarming: 'off', modelRetryLimit: 0 })
    const dispose = await binding
    expect(applied).toEqual([{ ...DEFAULT_RUNTIME_PREFERENCES, cacheWarming: 'streaming', modelRetryLimit: 'unlimited' }])
    dispose()
    expect(listening).toBe(false)
  })
})
