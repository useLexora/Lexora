<script setup lang="ts">
import type { SettingsGroupNode } from '../../model/settingsRegistry'
import { NAlert, NButton } from 'naive-ui'
import { computed } from 'vue'
import { useSettingsContext } from '../../settingsContext'

const props = defineProps<{ groups: readonly SettingsGroupNode[] }>()
const { pluginSettings, applicationSettings } = useSettingsContext()
const english = computed(() => applicationSettings.language.value === 'en-US')
const failed = computed(() => [...new Set(props.groups.flatMap(group => group.items.flatMap(item => item.kind === 'plugin' ? [item.field.extensionId] : [])))].filter(id => pluginSettings.errors.value.has(id)))
</script>

<template>
  <div v-if="failed.length" class="plugin-settings-status grid gap-[0.8rem]">
    <NAlert v-for="id in failed" :key="id" type="warning" :show-icon="false">
      <div class="flex items-center justify-between gap-4" role="status">
        <span>{{ english ? `Could not load settings for ${id}.` : `无法读取 ${id} 的插件设置。` }}</span>
        <NButton size="small" :loading="pluginSettings.loading.value.has(id)" :disabled="pluginSettings.loading.value.has(id)" @click="pluginSettings.reload(id)">
          {{ english ? 'Retry' : '重试' }}
        </NButton>
      </div>
    </NAlert>
  </div>
</template>
