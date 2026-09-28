import type { Ref } from 'vue'
import type { SettingsModuleNode } from '../model/settingsRegistry'
import { createInjectionState } from '@vueuse/core'

const [useProvideSettingsModule, injectSettingsModule] = createInjectionState((module: Readonly<Ref<SettingsModuleNode>>) => module)
export { useProvideSettingsModule }
export function useSettingsModule(): Readonly<Ref<SettingsModuleNode>> {
  const module = injectSettingsModule()
  if (!module)
    throw new Error('Settings module is unavailable')
  return module
}
