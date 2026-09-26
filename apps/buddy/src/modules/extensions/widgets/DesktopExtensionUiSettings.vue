<script setup lang="ts">
import type { WorkbenchUiSelectionTarget } from '@buddy-shared/workbench/workbenchUi'
import { computed } from 'vue'
import { useExtensionContext } from '../extensionContext'

defineProps<{ language: string }>()
const { ui, views } = useExtensionContext()
const entries = computed(() => ui.entries.value.filter(entry => entry.providers.length || entry.selected.length))
function choose(entry: WorkbenchUiSelectionTarget, event: Event): void {
  const id = (event.target as HTMLSelectElement).value
  if (entry.kind === 'control' && id)
    views.retryControl(id)
  ui.choose(entry, id ? [id] : [])
}
</script>

<template>
  <section v-if="entries.length" class="extension-ui-settings">
    <h2>{{ language === 'en-US' ? 'Interface appearance' : '界面呈现' }}</h2>
    <div v-for="entry in entries" :key="entry.target" class="extension-ui-settings__row" :data-ui-target="entry.target">
      <label v-if="entry.selection === 'single'" :for="`ui-${entry.target}`">{{ entry.title[language === 'en-US' ? 'en-US' : 'zh-CN'] }}</label>
      <span v-else :id="`label-${entry.target}`">{{ entry.title[language === 'en-US' ? 'en-US' : 'zh-CN'] }}</span>
      <select v-if="entry.selection === 'single'" :id="`ui-${entry.target}`" :value="entry.selected[0] ?? ''" @change="choose(entry, $event)">
        <option value="">
          {{ language === 'en-US' ? 'Default' : '默认内容' }}
        </option>
        <option v-if="entry.selected[0] && !entry.providers.some(provider => provider.placement.id === entry.selected[0])" :value="entry.selected[0]" disabled>
          {{ language === 'en-US' ? 'Unavailable' : '暂不可用' }}
        </option>
        <option v-for="provider in entry.providers" :key="provider.placement.id" :value="provider.placement.id">
          {{ provider.plugin.manifest.name }} · {{ provider.title }}
        </option>
      </select>
      <div v-else role="group" :aria-labelledby="`label-${entry.target}`" class="extension-ui-settings__choices">
        <label v-for="id in entry.selected.filter(id => !entry.providers.some(provider => provider.placement.id === id))" :key="id">
          <input type="checkbox" checked @change="ui.choose(entry, entry.selected.filter(value => value !== id))">
          {{ language === 'en-US' ? 'Unavailable' : '暂不可用' }}
        </label>
        <label v-for="provider in entry.providers" :key="provider.placement.id">
          <input type="checkbox" :disabled="entry.selected.length >= 8 && !entry.selected.includes(provider.placement.id)" :checked="entry.selected.includes(provider.placement.id)" @change="ui.choose(entry, ($event.target as HTMLInputElement).checked ? [...entry.selected, provider.placement.id] : entry.selected.filter(id => id !== provider.placement.id))">
          {{ provider.plugin.manifest.name }} · {{ provider.title }}
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>
.extension-ui-settings { display: grid; gap: 12px; margin-top: 18px; padding: 16px; border: 1px solid var(--buddy-border-subtle); border-radius: var(--buddy-radius-micro); }
.extension-ui-settings h2 { margin: 0; color: var(--buddy-text-strong); font-size: 14px; }
.extension-ui-settings__row { display: flex; align-items: center; justify-content: space-between; gap: 16px; color: var(--buddy-text-secondary); font-size: 13px; }
.extension-ui-settings__row select { min-width: 140px; max-width: 50%; border: 1px solid var(--buddy-border-subtle); border-radius: 6px; padding: 6px 8px; background: var(--buddy-surface-base); color: var(--buddy-text-primary); font: inherit; }
.extension-ui-settings__choices { display: grid; gap: 8px; }
.extension-ui-settings__choices label { display: flex; gap: 8px; align-items: center; }
</style>
