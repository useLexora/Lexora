<script setup lang="ts">
import type { MermaidBlockEvent, MermaidBlockNodeProps } from 'markstream-vue'
import { MermaidBlockNode, PreCodeNode } from 'markstream-vue'
import { useMessage } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { usePreviewWheelZoom } from '@/shared/ui/media/usePreviewWheelZoom'
import { desktopMermaidTheme } from '@/theme/mermaidTheme'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  node: MermaidBlockNodeProps['node']
  loading?: boolean
  isDark?: boolean
  clipboardWriter: (text: string) => Promise<void>
}>()

const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const message = useMessage()
const themeKey = computed(() => JSON.stringify(desktopMermaidTheme.value))
usePreviewWheelZoom()

async function copy(event: MermaidBlockEvent) {
  event.preventDefault()
  try {
    await props.clipboardWriter(props.node.code)
    message.success(t('desktop.chat.copied'))
  }
  catch {
    message.error(t('desktop.chat.copyFailed'))
  }
}
</script>

<template>
  <PreCodeNode v-if="loading || node.loading" :node="node" :loading="true" />
  <MermaidBlockNode
    v-else
    :key="themeKey"
    v-bind="$attrs"
    :node="node"
    :loading="false"
    :is-dark="isDark"
    :fit-preview-height="true"
    :show-collapse-button="true"
    :is-strict="true"
    :enable-mermaid-interactions="false"
    :enable-wheel-zoom="false"
    @copy="copy"
  />
</template>

<style scoped lang="scss">
:global(.mermaid-modal-panel) {
  --ms-font-sans: var(--buddy-font-body);
  --modal-bg: var(--buddy-surface-raised);
  --modal-fg: var(--buddy-reading-fg);
  --diagram-bg: var(--buddy-surface-raised);
  --code-action-fg: var(--buddy-text-secondary);
  --code-action-hover-bg: var(--buddy-state-hover);
  --code-action-hover-fg: var(--buddy-text-primary);
}
</style>
