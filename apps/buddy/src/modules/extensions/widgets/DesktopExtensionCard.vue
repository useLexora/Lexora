<script setup lang="ts">
import type { ExtensionStatus, ExtensionUnavailableInstallation } from '@buddy-shared/extensions/extensionApi'
import type { DropdownOption } from 'naive-ui'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NEllipsis, NTag, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import { extensionLabels } from '../extensionLabels'
import DesktopExtensionCompatibilityHint from './DesktopExtensionCompatibilityHint.vue'
import DesktopExtensionTags from './DesktopExtensionTags.vue'

const props = defineProps<{ item: ExtensionStatus, unavailablePending?: ExtensionUnavailableInstallation, language: string, busy: boolean, canOpen: boolean }>()
const emit = defineEmits<{
  toggle: []
  restart: []
  applyUpdate: []
  diagnostics: []
  remove: []
  open: []
  revokeResources: []
}>()
const labels = computed(() => extensionLabels(props.language))
const pending = computed(() => props.item.pending ?? props.unavailablePending)
const warning = computed(() => {
  const issue = props.item.incompatibility ?? pending.value?.incompatibility
  return issue ? { issue, version: props.item.incompatibility ? undefined : pending.value?.manifest.version } : null
})
const status = computed(() => props.item.incompatibility ? (props.language === 'en-US' ? 'Unavailable' : '暂不可用') : labels.value[props.item.state === 'failed' ? 'failedState' : props.item.state])
const actions = computed<DropdownOption[]>(() => {
  const pluginActions: DropdownOption[] = []
  if (props.item.manifest.permissions.localResources)
    pluginActions.push({ key: 'file-access', label: props.language === 'en-US' ? 'File access' : '文件访问', props: { role: 'menuitem' }, children: [{ key: 'revoke-resources', label: props.language === 'en-US' ? 'Revoke all access' : '撤销全部授权', props: { role: 'menuitem' } }] })
  return [
    ...pluginActions,
    ...(pluginActions.length ? [{ key: 'plugin-actions-divider', type: 'divider' as const }] : []),
    ...(props.item.pending && !props.item.pending.incompatibility ? [{ key: 'apply-update', label: labels.value.applyUpdate, props: { 'role': 'menuitem', 'data-testid': 'extension-apply-update-menu' } }] : []),
    { key: 'restart', label: labels.value.restart, disabled: !!props.item.incompatibility, props: { 'role': 'menuitem', 'data-testid': 'extension-restart' } },
    { key: 'diagnostics', label: labels.value.diagnostics, props: { role: 'menuitem' } },
    { key: 'divider', type: 'divider' },
    { key: 'remove', label: labels.value.remove, props: { 'role': 'menuitem', 'data-testid': 'extension-uninstall' } },
  ]
})
function handleAction(key: string | number) {
  if (key === 'restart')
    emit('restart')
  else if (key === 'apply-update')
    emit('applyUpdate')
  else if (key === 'diagnostics')
    emit('diagnostics')
  else if (key === 'remove')
    emit('remove')
  else if (key === 'revoke-resources')
    emit('revokeResources')
}
</script>

<template>
  <article class="extension-card box-border h-[200px] flex min-w-0 flex-col gap-2 border border-solid border-border rounded-micro bg-surface p-4" :data-extension-id="item.manifest.id" data-theme-surface="panel">
    <header class="extension-card__header flex min-w-0 flex-none items-start gap-3">
      <DesktopPluginIcon :src="item.iconUrl" :size="28" />
      <div class="min-w-0 flex-1">
        <h2 class="m-0 min-w-0 text-strong text-[14px] font-600 leading-[1.5]">
          <NEllipsis>{{ item.manifest.name }}</NEllipsis>
        </h2>
        <p class="flex min-w-0 items-center gap-2 mt-1 mr-0 mb-0 ml-0 text-muted text-[11px]">
          <span class="flex-none">{{ item.manifest.version }}</span>
          <NEllipsis class="min-w-0">
            {{ item.manifest.author || (language === 'en-US' ? 'Unsigned' : '未署名') }}
          </NEllipsis>
        </p>
      </div>
      <div class="flex flex-none items-center gap-1">
        <NTag size="small" :bordered="false" :type="item.incompatibility || item.state === 'failed' || item.state === 'blocked' ? 'warning' : 'default'">
          {{ status }}
        </NTag>
        <DesktopExtensionCompatibilityHint v-if="warning" :issue="warning.issue" :version="warning.version" :language="language" placement="bottom-end" />
      </div>
    </header>
    <div class="grid min-w-0 flex-none gap-[6px]">
      <NEllipsis v-if="item.manifest.description" :line-clamp="item.error && !item.incompatibility ? 1 : 2" class="text-muted text-[13px] leading-[1.6]">
        {{ item.manifest.description }}
      </NEllipsis>
      <NEllipsis v-if="item.error && !item.incompatibility" :line-clamp="1" class="extension-card__error text-danger font-mono">
        {{ item.error }}
      </NEllipsis>
    </div>
    <footer class="mt-auto flex min-w-0 flex-none flex-col gap-2">
      <DesktopExtensionTags :tags="item.manifest.tags" />
      <div class="flex min-w-0 flex-wrap items-center gap-1">
        <NTooltip v-if="pending" :disabled="!!pending.incompatibility">
          <template #trigger>
            <NButton type="primary" size="small" :disabled="busy || !!pending.incompatibility" data-testid="extension-apply-update" @click="emit('applyUpdate')">
              {{ labels.applyUpdate }}
            </NButton>
          </template>
          <div class="grid max-w-[280px] gap-1 text-[12px] leading-[1.6]">
            <span>{{ language === 'en-US' ? 'New version' : '新版本' }} {{ pending.manifest.version }}</span>
            <span>{{ labels.applyUpdateHint }}</span>
          </div>
        </NTooltip>
        <NButton v-if="canOpen" type="primary" size="small" :secondary="!!pending && !pending.incompatibility" :disabled="busy" @click="emit('open')">
          {{ language === 'en-US' ? 'Open' : '打开' }}
        </NButton>
        <NButton type="primary" :secondary="item.enabled" size="small" :disabled="busy || (!item.enabled && !!item.incompatibility)" :data-testid="item.enabled ? 'extension-disable' : 'extension-enable'" @click="emit('toggle')">
          {{ item.enabled ? labels.disable : labels.enable }}
        </NButton>
        <NDropdown trigger="click" :options="actions" :disabled="busy" @select="handleAction">
          <NButton quaternary size="small" class="extension-card__more" :disabled="busy" :aria-label="labels.more" data-testid="extension-card-more">
            <template #icon>
              <DesktopIcon :component="MoreHorizontal20Regular" :size="16" />
            </template>
          </NButton>
        </NDropdown>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.extension-card__error {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.extension-card__more {
  flex: none;
  width: 28px;
  height: 28px;
  margin-left: auto;
  padding: 0;
}
</style>
