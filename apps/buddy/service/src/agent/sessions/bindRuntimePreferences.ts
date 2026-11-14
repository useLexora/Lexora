import type { RuntimePreferences } from '../../../../shared/runtime/runtimePreferences'
import type { RuntimePreferenceSource } from '../../platform/RuntimePlatform'

export async function bindRuntimePreferences(
  source: RuntimePreferenceSource,
  apply: (preferences: RuntimePreferences) => void,
): Promise<() => void> {
  let updated = false
  const unsubscribe = source.subscribe((preferences) => {
    updated = true
    apply(preferences)
  })
  try {
    const preferences = await source.get()
    if (!updated)
      apply(preferences)
    return unsubscribe
  }
  catch (error) {
    unsubscribe()
    throw error
  }
}
