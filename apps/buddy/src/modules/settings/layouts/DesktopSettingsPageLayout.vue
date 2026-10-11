<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import DesktopRuntimePane from '@/platform/runtime/DesktopRuntimePane.vue'

defineProps<{ loading?: boolean, requiresRuntime?: boolean, fill?: boolean }>()
defineSlots<{
  actions?: () => unknown
  default: () => unknown
  description?: () => unknown
  title: () => unknown
}>()
</script>

<template>
  <section class="desktop-settings-page flex w-full h-full min-w-0 min-h-0 flex-col bg-surface">
    <header class="desktop-settings-page__header flex flex-none items-center justify-between gap-4 border-b-1 border-b-solid border-b-border py-0 px-4 h-region-header">
      <div class="flex min-w-0 flex-1 items-center gap-[12px]">
        <h1 class="desktop-settings-page__title overflow-hidden min-w-0 max-w-full flex-none m-0 text-[14px] font-600 text-ellipsis whitespace-nowrap">
          <slot name="title" />
        </h1>
        <p v-if="$slots.description" class="desktop-settings-page__description overflow-hidden min-w-0 m-0 text-muted text-[11px] leading-[16px] text-ellipsis whitespace-nowrap">
          <slot name="description" />
        </p>
      </div>
      <div v-if="$slots.actions" class="flex flex-none items-center gap-[8px]">
        <slot name="actions" />
      </div>
    </header>

    <DesktopRuntimePane :enabled="requiresRuntime" :loading="loading">
      <div v-if="fill" class="flex w-full h-full min-h-0 flex-col overflow-hidden">
        <div class="flex min-w-0 min-h-0 flex-1">
          <slot />
        </div>
      </div>
      <NScrollbar v-else class="desktop-settings-page__scroll">
        <div class="grid w-[min(100%,_64rem)] gap-[1.8rem] my-0 mx-auto pt-[clamp(20px,_3cqw,_24px)] pr-[clamp(1rem,_3cqw,_2.8rem)] pb-12 pl-[clamp(1rem,_3cqw,_2.8rem)]">
          <slot />
        </div>
      </NScrollbar>
    </DesktopRuntimePane>
  </section>
</template>

<style scoped lang="scss">
.desktop-settings-page {
  container-type: inline-size;
}

.desktop-settings-page__description {
  transform: translateY(1px);
}

.desktop-settings-page__scroll {
  min-height: 0;
  flex: 1;
}
</style>
