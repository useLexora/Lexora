<script setup lang="ts">
import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { DropdownOption } from 'naive-ui'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NEllipsis, NTag } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import { extensionLabels } from '../extensionLabels'

const props = defineProps<{ item: ExtensionStatus, language: string, busy: boolean, canOpen: boolean }>()
const emit = defineEmits<{
  toggle: []
  restart: []
  diagnostics: []
  remove: []
  open: []
  revokeResources: []
}>()
const labels = computed(() => extensionLabels(props.language))
const status = computed(() => labels.value[props.item.state === 'failed' ? 'failedState' : props.item.state])
const actions = computed<DropdownOption[]>(() => {
  const pluginActions: DropdownOption[] = []
  if (props.item.manifest.permissions.localResources)
    pluginActions.push({ key: 'file-access', label: props.language === 'en-US' ? 'File access' : '文件访问', props: { role: 'menuitem' }, children: [{ key: 'revoke-resources', label: props.language === 'en-US' ? 'Revoke all access' : '撤销全部授权', props: { role: 'menuitem' } }] })
  return [
    ...pluginActions,
    ...(pluginActions.length ? [{ key: 'plugin-actions-divider', type: 'divider' as const }] : []),
    { key: 'restart', label: labels.value.restart, props: { 'role': 'menuitem', 'data-testid': 'extension-restart' } },
    { key: 'diagnostics', label: labels.value.diagnostics, props: { role: 'menuitem' } },
    { key: 'divider', type: 'divider' },
    { key: 'remove', label: labels.value.remove, props: { 'role': 'menuitem', 'data-testid': 'extension-uninstall' } },
  ]
})
function handleAction(key: string | number) {
  if (key === 'restart')
    emit('restart')
  else if (key === 'diagnostics')
    emit('diagnostics')
  else if (key === 'remove')
    emit('remove')
  else if (key === 'revoke-resources')
    emit('revokeResources')
}
</script>

<template>
  <article class="extension-card flex min-w-0 flex-col gap-[12px] border-1 border-solid border-border rounded-micro bg-surface p-[16px]" :data-extension-id="item.manifest.id">
    <header class="flex min-w-0 items-start justify-between gap-[12px]">
      <DesktopPluginIcon :src="item.iconUrl" :size="28" />
      <div class="min-w-0 flex-1">
        <h2 class="m-0 text-strong text-[14px] font-600 leading-[1.5] [overflow-wrap:anywhere]">
          {{ item.manifest.name }}
        </h2>
        <p class="extension-card__meta flex min-w-0 items-center gap-[8px] mt-[4px] mr-0 mb-0 ml-0 text-muted text-[11px]">
          <span>{{ item.manifest.version }}</span>
          <NEllipsis class="extension-card__author">
            {{ item.manifest.author || (language === 'en-US' ? 'Unsigned' : '未署名') }}
          </NEllipsis>
        </p>
      </div>
      <NTag class="extension-card__status" size="small" :bordered="false" :type="item.state === 'failed' || item.state === 'blocked' ? 'warning' : 'default'">
        {{ status }}
      </NTag>
    </header>
    <NEllipsis v-if="item.manifest.description" class="extension-card__description" :line-clamp="2">
      {{ item.manifest.description }}
    </NEllipsis>
    <p v-if="item.pending" class="extension-card__pending text-accent-text">
      {{ labels.pending }} {{ item.pending.manifest.version }}
    </p>
    <code v-if="item.error" class="extension-card__error text-danger">{{ item.error }}</code>
    <footer class="flex min-w-0 flex-wrap items-center gap-[4px] mt-auto pt-[4px]">
      <NButton v-if="canOpen" size="small" secondary :disabled="busy" @click="emit('open')">
        {{ language === 'en-US' ? 'Open' : '打开' }}
      </NButton>
      <NButton secondary size="small" :disabled="busy" :data-testid="item.enabled ? 'extension-disable' : 'extension-enable'" @click="emit('toggle')">
        {{ item.enabled ? labels.disable : labels.enable }}
      </NButton>
      <NDropdown trigger="click" :options="actions" :disabled="busy" @select="handleAction">
        <NButton quaternary size="small" class="extension-card__more" :disabled="busy" :aria-label="labels.more" data-testid="extension-card-more">
          <template #icon>
            <DesktopIcon :component="MoreHorizontal20Regular" :size="16" />
          </template>
        </NButton>
      </NDropdown>
    </footer>
  </article>
</template>

<style scoped lang="scss">
.extension-card__author { min-width: 0; }
.extension-card__meta > span:first-child, .extension-card__status { flex: none; }
.extension-card__description { color: var(--buddy-text-secondary); font-size: 13px; line-height: 1.6; }
.extension-card__pending, .extension-card__error { margin: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }

.extension-card__more { flex: none; width: 28px; height: 28px; margin-left: auto; padding: 0; }
</style>
