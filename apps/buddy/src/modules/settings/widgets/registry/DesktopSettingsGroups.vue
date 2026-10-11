<script setup lang="ts">
import type { SettingsGroupNode } from '../../model/settingsRegistry'
import { useTemplateRef, watchPostEffect } from 'vue'
import { useRoute } from 'vue-router'
import { settingsText } from '../../model/settingsRegistry'
import { useSettingsContext } from '../../settingsContext'
import DesktopGeneralSettingField from '../app/DesktopGeneralSettingField.vue'
import DesktopPluginSetting from '../plugins/DesktopPluginSetting.vue'
import DesktopSettingsGroup from '../shared/DesktopSettingsGroup.vue'

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
  <div class="settings-groups gap-[1.8rem] [container-type:inline-size]" :class="fill ? 'is-fill flex flex-1 min-w-0 min-h-0 flex-col overflow-y-auto' : 'grid'">
    <slot name="status" />
    <section
      v-for="group in groups" :key="group.id" ref="sections" tabindex="-1" class="settings-group min-w-0 gap-[0.8rem]" :class="[
        { 'is-unframed': group.unframed },
        fill
          ? (group.unframed ? 'flex w-full min-h-80 flex-1 p-0 only:min-h-0' : 'grid flex-none w-[min(100%,64rem)] self-center px-8 py-6')
          : 'grid',
      ]" :data-settings-group="group.id"
    >
      <h2 v-if="group.title" class="m-0 text-[0.92rem]">
        {{ settingsText(group.title, language) }}
      </h2>
      <DesktopSettingsGroup class="settings-group__items" :unframed="group.unframed" :fill="fill">
        <template v-for="item in group.items" :key="item.id">
          <slot v-if="item.kind === 'content'" />
          <DesktopGeneralSettingField v-else-if="item.kind === 'general'" :field="item.field" />
          <DesktopPluginSetting v-else :field="item.field" />
        </template>
      </DesktopSettingsGroup>
    </section>
  </div>
</template>
