<script setup lang="ts">
import type { SettingsGroupNode } from '../../model/settingsRegistry'
import { useTemplateRef, watchPostEffect } from 'vue'
import { useRoute } from 'vue-router'
import { settingsText } from '../../model/settingsRegistry'
import { useSettingsContext } from '../../settingsContext'
import DesktopGeneralSettingField from '../app/DesktopGeneralSettingField.vue'
import DesktopPluginSetting from '../plugins/DesktopPluginSetting.vue'

defineProps<{ groups: readonly SettingsGroupNode[], fill?: boolean }>()
defineSlots<{ default?: () => unknown, status?: () => unknown }>()
const { applicationSettings: { language } } = useSettingsContext()
const route = useRoute()
const sections = useTemplateRef<HTMLElement[]>('sections')
let focused: HTMLElement | null = null
watchPostEffect(() => {
  const target = sections.value?.find(section => section.dataset.settingsGroup === route.query.group)
  if (target && target !== focused) {
    target.scrollIntoView({ block: 'nearest' })
    target.focus({ preventScroll: true })
  }
  focused = target ?? null
})
</script>

<template>
  <div class="settings-groups" :class="{ 'is-fill': fill }">
    <slot name="status" />
    <section v-for="group in groups" :key="group.id" ref="sections" tabindex="-1" class="settings-group" :class="{ 'is-unframed': group.unframed }" :data-settings-group="group.id">
      <h2 v-if="group.title">
        {{ settingsText(group.title, language) }}
      </h2>
      <div class="settings-group__items">
        <template v-for="item in group.items" :key="item.id">
          <slot v-if="item.kind === 'content'" />
          <DesktopGeneralSettingField v-else-if="item.kind === 'general'" :field="item.field" />
          <DesktopPluginSetting v-else :field="item.field" />
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-groups { display: grid; gap: 1.8rem; container-type: inline-size; }
.settings-group { display: grid; min-width: 0; gap: 0.8rem; }
.settings-group h2 { margin: 0; font-size: 0.92rem; }
.settings-group__items { overflow: hidden; border: 1px solid var(--buddy-border-subtle); border-radius: 0.65rem; background: var(--buddy-surface-base); }
.is-unframed > .settings-group__items { display: grid; gap: 1.8rem; overflow: visible; border: 0; border-radius: 0; background: transparent; }
.is-fill { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; overflow-y: auto; }
.is-fill > .settings-group { flex: none; width: min(100%, 64rem); align-self: center; padding: 1.5rem 2rem; }
.is-fill > .is-unframed { display: flex; width: 100%; min-height: 20rem; flex: 1; padding: 0; }
.is-fill > .is-unframed:only-child { min-height: 0; }
.is-fill > .is-unframed > .settings-group__items { display: flex; flex: 1; min-width: 0; min-height: 0; }
</style>
