<script setup lang="ts">
import type { WorkbenchMenuProps } from '@/shared/ui/contributions/workbenchUiContext'
import { matchesWorkbenchContext } from '@buddy-shared/workbench/workbenchContext'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { resolveBuddyLocale, translateBuddy } from '@/i18n/buddyI18n'
import { useWorkbenchUiScope } from '@/shared/ui/contributions/workbenchUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useExtensionContext } from '../extensionContext'

const props = defineProps<WorkbenchMenuProps>()
const { state, workbench, language } = useExtensionContext()
const scope = useWorkbenchUiScope()
const message = useMessage()
const busy = shallowRef(false)
let disposed = false
onScopeDispose(() => {
  disposed = true
})
const menus = computed(() => {
  const values = { ...workbench.value.values, ...props.values }
  return state.installed.value.filter(plugin => plugin.enabled && plugin.compatible).flatMap(plugin => plugin.manifest.contributes.menus.flatMap((menu) => {
    const command = plugin.manifest.contributes.commands.find(command => command.id === menu.command)
    return menu.target === props.target && command && matchesWorkbenchContext(menu.when, values) && matchesWorkbenchContext(command.when, values) ? [{ key: menu.id, label: command.title, plugin, menu }] : []
  })).sort((left, right) => left.menu.order - right.menu.order || left.key.localeCompare(right.key))
})
const actions = computed(() => props.target === 'task.actions' && props.taskId ? state.taskActions.value : [])
const items = computed(() => [...menus.value, ...actions.value.map(action => ({ key: action.actionId, label: action.title }))])
async function execute(key: string): Promise<void> {
  const item = menus.value.find(item => item.key === key)
  const action = actions.value.find(action => action.actionId === key)
  const conversationId = props.taskId
  if ((!item && !action) || props.disabled || busy.value)
    return
  const instanceId = scope?.instanceId()
  busy.value = true
  try {
    if (action && conversationId) {
      const result = await state.api.invokeTaskAction({ conversationId, extensionId: action.extensionId, actionId: action.actionId })
      if (!disposed && props.taskId === conversationId && result.status === 'skipped')
        message.info(language.value === 'en-US' ? 'No changes applied' : '本次未作更改')
      return
    }
    if (!item)
      return
    const selection = props.capture?.()
    const result = await state.api.executeMenu(item.plugin.manifest.id, item.menu.id, { target: props.target, instanceId, resource: selection?.resource ?? null, ...(item.plugin.manifest.permissions.selectedContent && selection?.content !== undefined ? { content: selection.content } : {}) })
    if (!disposed && !props.disabled && scope?.instanceId() === instanceId)
      selection?.apply?.(result)
  }
  catch {
    if (!disposed)
      message.error(translateBuddy(resolveBuddyLocale(language.value), 'desktop.command.failed'))
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <NDropdown v-if="items.length" trigger="click" :options="items" :disabled="disabled || busy" @select="execute">
    <NButton quaternary class="buddy-icon-button" :data-workbench-menu="target" :disabled="disabled || busy" :loading="busy" :aria-label="language === 'en-US' ? 'More actions' : '更多操作'">
      <template #icon>
        <DesktopIcon :component="MoreHorizontal20Regular" />
      </template>
    </NButton>
  </NDropdown>
</template>
