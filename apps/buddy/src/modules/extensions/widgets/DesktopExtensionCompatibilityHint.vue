<script setup lang="ts">
import type { ExtensionCompatibilityIssue } from '@buddy-shared/extensions/extensionCompatibility'
import { extensionUpgradeSuggested } from '@buddy-shared/extensions/extensionCompatibility'
import { Info20Regular } from '@vicons/fluent'
import { NButton, NPopover } from 'naive-ui'
import { nextTick, shallowRef, useId, useTemplateRef } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopExtensionCompatibilityNotice from './DesktopExtensionCompatibilityNotice.vue'

const props = defineProps<{ issue: ExtensionCompatibilityIssue, language: string, version?: string, placement?: 'top-start' | 'bottom-end' }>()
const show = shallowRef(false)
const id = useId()
const trigger = useTemplateRef('trigger')
const content = useTemplateRef<HTMLDivElement>('content')

function updateShow(value: boolean) {
  if (value || (!content.value?.contains(document.activeElement) && trigger.value?.$el !== document.activeElement))
    show.value = value
}

function blur(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || (!content.value?.contains(event.relatedTarget) && event.relatedTarget !== trigger.value?.$el))
    show.value = false
}

async function enter(event: KeyboardEvent) {
  if (event.shiftKey || !extensionUpgradeSuggested(props.issue))
    return
  event.preventDefault()
  show.value = true
  await nextTick()
  content.value?.querySelector<HTMLElement>('[role="link"]')?.focus()
}

function dismiss() {
  trigger.value?.$el.focus()
  show.value = false
}
</script>

<template>
  <NPopover :show="show" trigger="hover" :placement="placement ?? 'top-start'" to=".buddy-app" :delay="150" :duration="200" :keep-alive-on-hover="true" :style="{ maxWidth: 'min(280px, calc(100vw - 32px))' }" @update:show="updateShow" @clickoutside="show = false">
    <template #trigger>
      <NButton ref="trigger" quaternary size="small" class="buddy-icon-button" :aria-label="language === 'en-US' ? 'Why this plugin is unavailable' : '查看插件不可用原因'" :aria-expanded="show" :aria-controls="show ? id : undefined" aria-haspopup="dialog" @focus="show = true" @blur="blur" @click="show = true" @keydown.tab="enter" @keydown.esc.stop.prevent="show = false">
        <template #icon>
          <DesktopIcon :component="Info20Regular" :size="16" color="var(--buddy-status-warning-text)" />
        </template>
      </NButton>
    </template>
    <div :id="id" ref="content" role="dialog" :aria-label="language === 'en-US' ? 'Plugin compatibility' : '插件兼容性说明'" @focusout="blur" @keydown.esc.stop.prevent="dismiss" @keydown.shift.tab.prevent="trigger?.$el.focus()">
      <DesktopExtensionCompatibilityNotice :issue="issue" :language="language" :version="version" />
    </div>
  </NPopover>
</template>
