<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import { computed } from 'vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { extensionLabels } from '../extensionLabels'

const props = defineProps<{ language: string }>()
defineSlots<{
  actions: () => unknown
  default: () => unknown
}>()
const section = defineModel<'marketplace' | 'installed'>('section', { required: true })
const labels = computed(() => extensionLabels(props.language))
const sections = computed(() => [
  { label: labels.value.marketplace, value: 'marketplace' },
  { label: labels.value.installed, value: 'installed' },
] as const)
</script>

<template>
  <section class="desktop-extension-workbench flex w-full min-w-0 min-h-0 flex-1 flex-col bg-surface">
    <header class="desktop-extension-workbench__header flex flex-none items-center justify-between gap-[16px] border-b-1 border-b-solid border-b-border py-0 px-[18px] h-region-header">
      <DesktopSegmentedControl
        v-model="section"
        class="desktop-extension-workbench__sections"
        :aria-label="labels.title"
        :options="sections"
      />
      <div class="desktop-extension-workbench__actions flex flex-none items-center gap-[8px]">
        <slot name="actions" />
      </div>
    </header>
    <NScrollbar class="desktop-extension-workbench__scroll" content-style="min-height: 100%;">
      <div class="desktop-extension-workbench__content flex min-h-full box-border flex-col gap-[12px] pt-[14px] pr-[18px] pb-[36px] pl-[18px]">
        <slot />
      </div>
    </NScrollbar>
  </section>
</template>

<style scoped lang="scss">
.desktop-extension-workbench {
  container-type: inline-size;
}
.desktop-extension-workbench__scroll { min-height: 0; flex: 1; }

@container (max-width: 600px) {
  .desktop-extension-workbench__header { gap: 8px; padding: 0 12px; }
  .desktop-extension-workbench__actions { gap: 4px; }
  .desktop-extension-workbench__content { padding: 10px 12px 28px; }
}
</style>
