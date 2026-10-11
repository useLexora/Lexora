<script setup lang="ts">
import type { LocalConnector } from '@buddy-shared/connectors/connectorApi'
import type { ConnectorToolSummary } from '@buddy-shared/connectors/connectorState'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NEmpty, NInput, NModal, NScrollbar, NTag } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ connector: LocalConnector, tools: readonly ConnectorToolSummary[], language: BuddyLocale }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useBuddyI18n(() => props.language)
const query = shallowRef('')
const filtered = computed(() => {
  const value = query.value.trim().toLocaleLowerCase()
  return props.tools.filter(tool => `${tool.name} ${tool.title} ${tool.description}`.toLocaleLowerCase().includes(value))
})
</script>

<template>
  <NModal show preset="card" :title="connector.name" :style="{ width: 'min(680px, calc(100vw - 48px))' }" @close="emit('close')" @update:show="value => !value && emit('close')">
    <p class="text-muted text-[0.83rem] leading-[1.65] mt-0 mr-0 mb-4 ml-0">
      {{ t(connector.runtime.status === 'ready' ? 'desktop.mcp.toolNotice' : 'desktop.mcp.cachedToolNotice') }}
    </p>
    <NInput v-model:value="query" clearable :placeholder="t('desktop.mcp.searchTools')" :input-props="{ 'aria-label': t('desktop.mcp.searchTools') }" />
    <NScrollbar style="max-height: min(440px, 55vh)">
      <NEmpty v-if="!filtered.length" :description="t('desktop.mcp.noMatchingTools')" class="mcp-tools__empty" />
      <article v-for="tool in filtered" :key="tool.name" class="mcp-settings__tool py-4 px-0 border-b-1 border-b-solid border-b-border">
        <strong>{{ tool.title }}</strong>
        <NTag v-if="tool.readOnly" size="small" :bordered="false">
          {{ t('desktop.mcp.readOnly') }}
        </NTag>
        <code v-if="tool.title !== tool.name">{{ tool.name }}</code>
        <p>{{ tool.description }}</p>
      </article>
    </NScrollbar>
  </NModal>
</template>

<style scoped lang="scss">
.mcp-tools__empty { padding: 2rem; }
.mcp-settings__tool strong { overflow-wrap: anywhere; }
.mcp-settings__tool code { display: block; margin-top: 0.4rem; font-size: 0.78rem; color: var(--buddy-text-secondary); overflow-wrap: anywhere; }
.mcp-settings__tool p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.83rem; line-height: 1.6; margin: 0.4rem 0 0; }
</style>
