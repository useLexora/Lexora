import type { BuddyToolOption } from '@buddy-shared/buddies/buddyApi'
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import { skillInvocationName } from '@buddy-shared/skills/skillApi'
import { computed, onScopeDispose, shallowRef, watch } from 'vue'
import { requireDesktopApi } from '@/platform/desktop/desktopApi'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { useBuddiesContext } from '../buddiesContext'
import { buddyLabels } from '../buddyLabels'

export function useBuddySettingsOptions() {
  const { localChat: api } = requireDesktopApi()
  const { ready, api: buddies, modelCatalog } = useBuddiesContext()
  const { language } = useDesktopUi()
  const skillCatalog = shallowRef<readonly LocalSkill[]>([])
  const toolCatalog = shallowRef<readonly BuddyToolOption[]>([])
  const failed = shallowRef(false)
  let generation = 0
  async function refresh() {
    if (!ready.value)
      return
    const current = ++generation
    const [skills, tools] = await Promise.allSettled([
      api.skills.list(null, true),
      buddies.toolOptions(),
    ])
    if (current !== generation || !ready.value)
      return
    failed.value = skills.status === 'rejected' || tools.status === 'rejected'
    if (skills.status === 'fulfilled')
      skillCatalog.value = skills.value.skills
    if (tools.status === 'fulfilled')
      toolCatalog.value = tools.value
  }
  watch(ready, (value) => {
    if (value)
      void refresh()
    else
      generation++
  }, { immediate: true })
  onScopeDispose(api.skills.onChanged(() => void refresh()))
  onScopeDispose(api.connectors.onChanged(() => void refresh()))
  onScopeDispose(() => generation++)
  const tools = computed(() => toolCatalog.value.map(tool => ({ value: tool.id, label: `${tool.title} · ${tool.source.title}` })))
  const skills = computed(() => {
    const labels = buddyLabels(language.value)
    const scopes = { global: labels.scopeGlobal, directory: labels.scopeDirectory, space: labels.scopeSpace }
    return skillCatalog.value.map(skill => ({
      value: skill.id,
      label: `${skillInvocationName(skill)} · ${skill.plugin ? `${skill.plugin.extensionName} · ${skill.plugin.extensionId}` : scopes[skill.source]}${skill.status === 'available' ? '' : ` · ${labels.unavailableChoice}`}`,
      disabled: skill.status !== 'available',
    }))
  })
  return { ...modelCatalog, skills, tools, skillCatalog, toolCatalog, failed, refresh }
}
