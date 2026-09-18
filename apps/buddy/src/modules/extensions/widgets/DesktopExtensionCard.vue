<script setup lang="ts">
import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { DropdownOption } from 'naive-ui'
import { MoreHorizontal20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NEllipsis, NTag } from 'naive-ui'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopPluginIcon from '@/shared/ui/icon/DesktopPluginIcon.vue'
import { extensionLabels } from '../extensionLabels'

const props = defineProps<{ item: ExtensionStatus, language: string, busy: boolean }>()
const emit = defineEmits<{
  toggle: []
  restart: []
  diagnostics: []
  remove: []
  open: []
}>()
const labels = computed(() => extensionLabels(props.language))
const status = computed(() => labels.value[props.item.state === 'failed' ? 'failedState' : props.item.state])
const actions = computed<DropdownOption[]>(() => [
  { key: 'diagnostics', label: labels.value.diagnostics, props: { role: 'menuitem' } },
  { key: 'divider', type: 'divider' },
  { key: 'remove', label: labels.value.remove, props: { 'role': 'menuitem', 'data-testid': 'extension-uninstall' } },
])
function handleAction(key: string | number) {
  if (key === 'diagnostics')
    emit('diagnostics')
  else if (key === 'remove')
    emit('remove')
}
</script>

<template>
  <article class="extension-card" :data-extension-id="item.manifest.id">
    <header class="extension-card__header">
      <DesktopPluginIcon :src="item.iconUrl" :size="28" />
      <div class="extension-card__identity">
        <h2 class="extension-card__name">
          {{ item.manifest.name }}
        </h2>
        <p class="extension-card__meta">
          <span>{{ item.manifest.version }}</span>
          <NEllipsis>{{ item.manifest.id }}</NEllipsis>
        </p>
      </div>
      <NTag class="extension-card__status" size="small" :bordered="false" :type="item.state === 'failed' || item.state === 'blocked' ? 'warning' : 'default'">
        {{ status }}
      </NTag>
    </header>
    <NEllipsis v-if="item.manifest.description" class="extension-card__description" :line-clamp="2">
      {{ item.manifest.description }}
    </NEllipsis>
    <p v-if="item.pending" class="extension-card__pending">
      {{ labels.pending }} {{ item.pending.manifest.version }}
    </p>
    <code v-if="item.error" class="extension-card__error">{{ item.error }}</code>
    <footer class="extension-card__actions">
      <NButton v-if="item.enabled && item.compatible && item.manifest.contributes.navigation" size="small" secondary @click="emit('open')">
        {{ language === 'en-US' ? 'Open' : '打开' }}
      </NButton>
      <NButton secondary size="small" :disabled="busy" :data-testid="item.enabled ? 'extension-disable' : 'extension-enable'" @click="emit('toggle')">
        {{ item.enabled ? labels.disable : labels.enable }}
      </NButton>
      <NButton quaternary size="small" :disabled="busy" data-testid="extension-restart" @click="emit('restart')">
        {{ labels.restart }}
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

<style scoped>
.extension-card { display: flex; min-width: 0; flex-direction: column; gap: 12px; border: 1px solid var(--buddy-border-subtle); border-radius: var(--buddy-radius-micro); background: var(--buddy-surface-base); padding: 16px; }
.extension-card__header { display: flex; min-width: 0; align-items: start; justify-content: space-between; gap: 12px; }
.extension-card__identity { min-width: 0; flex: 1; }
.extension-card__name { margin: 0; color: var(--buddy-text-strong); font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.extension-card__meta { display: flex; min-width: 0; align-items: center; gap: 8px; margin: 4px 0 0; color: var(--buddy-text-secondary); font-size: 11px; }
.extension-card__meta > span:first-child, .extension-card__status { flex: none; }
.extension-card__description { color: var(--buddy-text-secondary); font-size: 13px; line-height: 1.6; }
.extension-card__pending, .extension-card__error { margin: 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.extension-card__pending { color: var(--buddy-accent-text); }
.extension-card__error { color: var(--buddy-status-danger-text); }
.extension-card__actions { display: flex; align-items: center; gap: 4px; margin-top: auto; padding-top: 4px; }
.extension-card__more { width: 28px; height: 28px; margin-left: auto; padding: 0; }
</style>
