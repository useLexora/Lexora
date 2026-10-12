import type { BuddyToolOption } from '@buddy-shared/buddies/buddyApi'
import type { LocalProvider, LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { useBuddiesContext } from '../buddiesContext'
import { buddyLabels } from '../buddyLabels'

export function useBuddySettingsOptions() {
  const { localChat: api } = requireDesktopApi()
  const { ready, api: buddies } = useBuddiesContext()
  const { language } = useDesktopUi()
  const models = shallowRef<readonly LocalRuntimeModelOption[]>([])
  const providers = shallowRef<readonly LocalProvider[]>([])
  const skillCatalog = shallowRef<readonly LocalSkill[]>([])
  const toolCatalog = shallowRef<readonly BuddyToolOption[]>([])
  const failed = shallowRef(false)
  let generation = 0
  async function refresh() {
    if (!ready.value)
      return
    const current = ++generation
    const results = await Promise.allSettled([
      api.providers.listModels(),
      api.skills.list(null, true),
      buddies.toolOptions(),
      api.providers.list(),
    ])
    if (current !== generation || !ready.value)
      return
    failed.value = results.some(result => result.status === 'rejected')
    if (results[0].status === 'fulfilled')
      models.value = results[0].value
    if (results[1].status === 'fulfilled')
      skillCatalog.value = results[1].value.skills
    if (results[2].status === 'fulfilled')
      toolCatalog.value = results[2].value
    if (results[3].status === 'fulfilled')
      providers.value = results[3].value
  }
  watch(ready, (value) => {
    if (value)
      void refresh()
    else
      generation++
  }, { immediate: true })
  onScopeDispose(api.providers.onChanged(() => void refresh()))
  onScopeDispose(api.skills.onChanged(() => void refresh()))
  onScopeDispose(api.connectors.onChanged(() => void refresh()))
  onScopeDispose(() => generation++)
  const tools = computed(() => toolCatalog.value.map(tool => ({ value: tool.id, label: `${tool.title} · ${tool.source.title}` })))
  const skills = computed(() => {
    const labels = buddyLabels(language.value)
    const scopes = { global: labels.scopeGlobal, directory: labels.scopeDirectory, space: labels.scopeSpace }
    return skillCatalog.value.map(skill => ({
      value: skill.id,
      label: `${skill.name} · ${scopes[skill.source]}${skill.status === 'available' ? '' : ` · ${labels.unavailableChoice}`}`,
      disabled: skill.status !== 'available',
    }))
  })
  return { models, providers, skills, tools, skillCatalog, toolCatalog, failed, refresh }
}
